// DSH Desktop — 将 DSH Web 界面封装为 macOS 桌面应用
// 功能：常驻 Dock；启动时检测 3080 端口，未响应则自动拉起 dsh 服务；退出时回收由本应用启动的服务。
'use strict';

const { app, BrowserWindow, Menu, dialog, shell, globalShortcut, Tray, nativeImage, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');
const { createLanProxy, randomToken } = require('./lan-proxy');

const DEFAULT_PORT = 3080;
const DEFAULT_WORKSPACE = os.homedir(); // 新用户默认主目录；可通过配置文件修改
const DEFAULT_LAN_PORT = 3082;          // 局域网代理端口（令牌门禁，转发到 3080）
const POLL_INTERVAL_MS = 700;
const START_TIMEOUT_MS = 30_000;

let mainWindow = null;
let lanPanel = null;
let tray = null;
let lanProxy = null; // 局域网代理 server
let serverChild = null; // 本应用拉起的 dsh 进程
let serverStartedByUs = false;
let isQuitting = false;
let appConfig = {};

// ── 日志（写入 userData/app.log，便于排查 open 启动的应用）──────────────────
function log(...args) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.log'),
      `${new Date().toISOString()} ${args.join(' ')}\n`);
  } catch { /* 忽略日志错误 */ }
}

// ── 配置 ────────────────────────────────────────────────────────────────────
// 配置文件：~/Library/Application Support/DSH Desktop/config.json
// 环境变量覆盖（主要用于测试）：DSH_DESKTOP_PORT / DSH_DESKTOP_WORKSPACE / DSH_DESKTOP_DSH_BIN
// 命令行覆盖（open --args 传入，优先级最高）：--dsh-port / --dsh-workspace / --dsh-home
function argvValue(key) {
  const prefix = `--${key}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function loadConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    file = {};
  }
  const cfg = {
    port: parseInt(argvValue('dsh-port') || process.env.DSH_DESKTOP_PORT, 10) || file.port || DEFAULT_PORT,
    workspaceDir: argvValue('dsh-workspace') || process.env.DSH_DESKTOP_WORKSPACE || file.workspaceDir || DEFAULT_WORKSPACE,
    dshBin: process.env.DSH_DESKTOP_DSH_BIN || file.dshBin || '',
    lanEnabled: !!file.lanEnabled,
    lanPort: file.lanPort || DEFAULT_LAN_PORT,
    lanToken: file.lanToken || '',
    // 远程模式：设置后本机不再启动 DSH 服务，窗口直接连接远程地址（如 mini 的隧道）
    remoteUrl: file.remoteUrl || '',
    remoteToken: file.remoteToken || '',
  };
  const homeOverride = argvValue('dsh-home');
  if (homeOverride) process.env.DSH_HOME = homeOverride; // 测试隔离用
  // 调试覆盖：应用包内 Resources/dev-config.json（open 启动时无法传 env/argv，用此文件注入测试配置）
  try {
    const devPath = path.join(process.resourcesPath || '', 'dev-config.json');
    if (fs.existsSync(devPath)) {
      const dev = JSON.parse(fs.readFileSync(devPath, 'utf8'));
      if (dev.port) cfg.port = dev.port;
      if (dev.workspaceDir) cfg.workspaceDir = dev.workspaceDir;
      if (dev.dshBin) cfg.dshBin = dev.dshBin;
      if (dev.remoteUrl) cfg.remoteUrl = dev.remoteUrl;
      if (dev.remoteToken) cfg.remoteToken = dev.remoteToken;
      if (dev.lanEnabled !== undefined) cfg.lanEnabled = !!dev.lanEnabled;
      if (dev.lanPort) cfg.lanPort = dev.lanPort;
      if (dev.lanToken) cfg.lanToken = dev.lanToken;
      if (dev.home) process.env.DSH_HOME = dev.home;
      log('[main] 应用调试覆盖 dev-config:', JSON.stringify(dev));
    }
  } catch (e) {
    log('[main] dev-config 读取失败:', e.message);
  }
  // 补写缺失的配置键（升级后老配置文件没有新键）
  const merged = { ...file, ...cfg };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('无法写入配置文件：', e.message);
  }
  return cfg;
}

function persistConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2));
  } catch (e) {
    log('[config] 写入失败:', e.message);
  }
}

// ── 内置运行时（零依赖安装）──────────────────────────────────────────────────
// 安装包携带 Node 二进制 + dsh 全家桶（Resources/runtime/），用户无需装 Node/npm。
function bundledRuntime() {
  const nodeBin = path.join(process.resourcesPath, 'runtime', 'node', 'node');
  const dshEntry = path.join(process.resourcesPath, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(nodeBin) && fs.existsSync(dshEntry)) {
    return { nodeBin, dshEntry };
  }
  return null;
}

// ── 定位 dsh 可执行文件 ─────────────────────────────────────────────────────
function findDshBin(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  // 1) npx 缓存：~/.npm/_npx/<hash>/node_modules/.bin/dsh，取最新的一个
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  try {
    const dirs = fs.readdirSync(npxRoot)
      .map((d) => path.join(npxRoot, d, 'node_modules', '.bin', 'dsh'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dirs.length) return dirs[0];
  } catch { /* 目录不存在时忽略 */ }
  // 2) PATH 查找：登录 shell 加载用户的完整 PATH（覆盖 npm 全局安装 / nvm / volta 等）
  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v dsh'], {
      encoding: 'utf8', timeout: 10000,
    }).trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch { /* 不在 PATH 中 */ }
  // 3) 兜底：常见固定路径
  const candidates = ['/opt/homebrew/bin/dsh', '/usr/local/bin/dsh', '/usr/bin/dsh'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// ── 端口探测 ────────────────────────────────────────────────────────────────
function isServerUp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isServerUp(port)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

// ── 启动 DSH 服务 ───────────────────────────────────────────────────────────
// dshBin 为空时使用内置运行时（零依赖：随包 node + dsh，无需用户安装）
function startDshServer(port, workspaceDir, dshBin) {
  const logPath = path.join(app.getPath('userData'), 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
  const env = {
    ...process.env,
    HOME: os.homedir(),
    PATH: `${process.env.PATH || ''}${path.delimiter}${extraPath}`,
  };
  const args = ['--profile', 'web', '--port', String(port)];
  const bundled = bundledRuntime();
  let command, spawnArgs;
  if (bundled) {
    command = bundled.nodeBin;
    spawnArgs = [bundled.dshEntry, ...args];
    log('[spawn] 使用内置运行时:', bundled.nodeBin, bundled.dshEntry, args.join(' '), 'cwd=', workspaceDir);
  } else {
    command = dshBin;
    spawnArgs = args;
    log('[spawn]', dshBin, args.join(' '), 'cwd=', workspaceDir);
  }
  serverChild = spawn(command, spawnArgs, {
    cwd: workspaceDir,
    detached: true, // 独立进程组，退出时可整组回收
    env,
    stdio: ['ignore', logFd, logFd],
  });
  serverStartedByUs = true;
  log('[spawn] child pid=', serverChild.pid);
  serverChild.on('error', (err) => {
    log('[spawn] ERROR:', err.message);
  });
  serverChild.on('exit', (code, signal) => {
    log(`[spawn] 退出 code=${code} signal=${signal}`);
    serverChild = null;
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'DSH 服务已停止',
        message: 'DSH 服务进程意外退出。',
        detail: '点击“重试”将重新尝试拉起服务。',
        buttons: ['重试', '退出应用'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) bootstrapServer();
        else app.quit();
      });
    }
  });
  return serverChild;
}

function stopDshServer() {
  if (serverChild && serverChild.pid) {
    try {
      // detached 进程组，负 PID 整组终止，连带子进程
      process.kill(-serverChild.pid, 'SIGTERM');
    } catch { /* 已退出 */ }
    serverChild = null;
  }
}

// ── 窗口 ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'DSH Desktop',
    backgroundColor: '#0b0d14',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 白屏自愈：页面 JS 崩溃（整页变白）时自动重新加载，避免"只能关掉重启"
  watchForBlank(mainWindow);

  // 关闭窗口 = 隐藏（应用继续常驻 Dock），Cmd+Q 才真正退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ── 白屏自愈 + 崩溃取证 ─────────────────────────────────────────────────────
// DSH 客户端偶发 JS 崩溃导致整页白屏（浏览器里刷新可恢复）。壳层兜底：
// 1) 页面 console 报"未捕获异常"→ 记日志（取证）+ 自动 reload（20s 退避防循环）
// 2) body 空置连续两轮（约 6s）→ 自动 reload（覆盖无 console 输出的崩溃）
// 3) 渲染进程被杀 → 延迟重载一次
let blankCount = 0
let lastAutoReloadAt = 0

function autoReload(win, reason) {
  if (Date.now() - lastAutoReloadAt < 20000) return false
  lastAutoReloadAt = Date.now()
  log(`[watch] ${reason}，自动重新加载页面`)
  setTimeout(() => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload()
  }, 800)
  return true
}

function watchForBlank(win) {
  // 崩溃取证 + 即时自愈：React 未捕获异常必然打到 console
  win.webContents.on('console-message', (event, level, message) => {
    const msg = typeof event === 'object' && event.message !== undefined ? String(event.message) : String(message ?? '')
    const lvl = typeof event === 'object' && event.level !== undefined ? event.level : level
    if (lvl === 'error' || lvl === 3) {
      log('[page-err]', msg.slice(0, 600))
      if (/uncaught|above error occurred|maximum update|is not a function|undefined is not|cannot read propert|invalid hook|key=|minified react error/i.test(msg)) {
        autoReload(win, '页面 JS 崩溃')
      }
    }
  })

  const checker = setInterval(async () => {
    if (!win || win.isDestroyed()) { clearInterval(checker); return }
    const wc = win.webContents
    if (!/^https?:/.test(wc.getURL())) return // 只盯 DSH 页面（http/https），不盯加载页
    let empty = false
    try {
      empty = await wc.executeJavaScript(
        `(() => { const b = document.body; if (!b) return true; ` +
        `const t = (b.innerText || '').trim(); return t.length === 0 && b.children.length <= 1; })()`
      )
    } catch { return }
    if (empty) {
      blankCount += 1
      if (blankCount >= 2) {
        blankCount = 0
        autoReload(win, '检测到页面空白')
      }
    } else {
      blankCount = 0
    }
  }, 3000)
  win.on('closed', () => clearInterval(checker))

  // 渲染进程被杀（崩溃/内存不足）：延迟重载一次
  win.webContents.on('render-process-gone', (_e, details) => {
    log('[watch] 渲染进程退出:', details.reason)
    autoReload(win, '渲染进程退出')
  })
}

// ── 局域网访问（壳内令牌代理，转发到本机 127.0.0.1:port）──────────────────
async function startLanProxy() {
  if (lanProxy) return true;
  if (!appConfig.lanToken) appConfig.lanToken = randomToken();
  try {
    const { server } = await createLanProxy({
      port: appConfig.lanPort,
      upstreamPort: appConfig.port,
      token: appConfig.lanToken,
      onLog: (m) => log(m),
    });
    lanProxy = server;
    appConfig.lanEnabled = true;
    persistConfig();
    log('[lan] 代理已启动 0.0.0.0:' + appConfig.lanPort);
    return true;
  } catch (err) {
    log('[lan] 代理启动失败:', err.message);
    if (err.code === 'EADDRINUSE') {
      dialog.showMessageBox(lanPanel, {
        type: 'error',
        title: '端口被占用',
        message: `局域网端口 ${appConfig.lanPort} 已被占用。`,
        detail: '可在配置文件 config.json 中修改 lanPort。',
      });
    }
    return false;
  }
}

function stopLanProxy() {
  if (lanProxy) {
    try { lanProxy.close(); } catch { /* 已关闭 */ }
    lanProxy = null;
  }
  // 注意：退出时停止代理但不改 appConfig.lanEnabled（那是用户偏好，需持久化保留）
  log('[lan] 代理已停止');
}

async function setLanEnabled(on) {
  if (on) {
    const ok = await startLanProxy();
    return { enabled: ok && appConfig.lanEnabled, error: ok ? '' : '启动失败', port: appConfig.lanPort };
  }
  stopLanProxy();
  appConfig.lanEnabled = false; // 只有用户显式关闭才持久化
  persistConfig();
  return { enabled: false, error: '', port: appConfig.lanPort };
}

function lanAddresses() {
  const addrs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addrs.push(iface.address);
      }
    }
  }
  return [...new Set(addrs)];
}

async function buildLanAddresses() {
  const token = appConfig.lanToken || '';
  const out = [];
  for (const ip of lanAddresses()) {
    const url = `http://${ip}:${appConfig.lanPort}/?token=${encodeURIComponent(token)}`;
    try {
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } });
      out.push({ ip, url, qr });
    } catch (e) {
      log('[lan] 二维码生成失败:', e.message);
    }
  }
  return out;
}

// ── 局域网面板窗口 ──────────────────────────────────────────────────────────
function openLanPanel() {
  if (lanPanel && !lanPanel.isDestroyed()) {
    lanPanel.show();
    lanPanel.focus();
    return;
  }
  lanPanel = new BrowserWindow({
    width: 430,
    height: 660,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '局域网访问',
    backgroundColor: '#0b0d14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lanPanel.loadFile(path.join(__dirname, 'lan-panel.html'));
  lanPanel.once('ready-to-show', () => lanPanel.show());
  lanPanel.on('closed', () => { lanPanel = null; });
}

function registerIpc() {
  ipcMain.handle('lan:state', () => {
    log('[面板] lan:state 被调用');
    return {
      enabled: !!appConfig.lanEnabled,
      port: appConfig.lanPort,
      token: appConfig.lanToken,
    };
  });
  ipcMain.handle('lan:setEnabled', async (_e, on) => {
    log('[面板] lan:setEnabled =', on);
    const r = await setLanEnabled(!!on);
    return { ...r, token: appConfig.lanToken };
  });
  ipcMain.handle('lan:addresses', () => {
    log('[面板] lan:addresses 被调用（构建二维码）');
    return buildLanAddresses();
  });
  ipcMain.handle('lan:regenerateToken', async () => {
    appConfig.lanToken = randomToken();
    persistConfig();
    return { token: appConfig.lanToken };
  });
  ipcMain.handle('lan:close', () => {
    if (lanPanel && !lanPanel.isDestroyed()) lanPanel.close();
  });
}

// ── 托盘 + 全局快捷键 ───────────────────────────────────────────────────────
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('DSH Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示/隐藏窗口', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '局域网访问…', click: () => openLanPanel() },
    { type: 'separator' },
    { label: '退出 DSH Desktop', click: () => app.quit() },
  ]));
  tray.on('click', () => toggleWindow());
}

function registerShortcuts() {
  const ok = globalShortcut.register('CommandOrControl+Shift+D', () => showWindow());
  log('[main] 全局快捷键 Cmd/Ctrl+Shift+D 注册', ok ? '成功' : '失败');
}

// ── 启动流程 ────────────────────────────────────────────────────────────────
async function bootstrapServer() {
  const { port, workspaceDir, dshBin: configuredBin } = appConfig;
  const dshBin = findDshBin(configuredBin);
  const bundled = bundledRuntime();
  log('[bootstrap] port=', port, 'workspace=', workspaceDir, 'dshBin=', dshBin || '(null)', 'bundled=', bundled ? 'yes' : 'no');

  if (!dshBin && !bundled) {
    log('[bootstrap] 找不到 dsh 且无内置运行时');
    dialog.showMessageBox({
      type: 'error',
      title: '找不到 dsh',
      message: '未找到 dsh 可执行文件，无法自动启动 DSH 服务。',
      detail: `请先安装 DSH 服务端（需要 Node.js）：\n\n` +
        `  方式一（推荐）：npm install -g @deepseek-ai/dsh\n` +
        `  方式二：npx -y @deepseek-ai/dsh --profile web\n\n` +
        `安装后重新打开应用即可；也可在配置文件中手动指定 dshBin 路径。\n` +
        `配置文件：${path.join(app.getPath('userData'), 'config.json')}`,
    });
    return false;
  }

  let ws = workspaceDir;
  if (!fs.existsSync(ws)) {
    ws = os.homedir();
    log('[bootstrap] 工作目录不存在，回退到主目录:', workspaceDir, '->', ws);
    dialog.showMessageBox({
      type: 'warning',
      title: '工作目录不存在',
      message: `配置的工作目录不存在：${workspaceDir}`,
      detail: `已临时改用主目录：${ws}\n可在菜单「DSH Desktop → 打开配置文件」中修改 workspaceDir。`,
    });
  }

  if (await isServerUp(port)) {
    log('[bootstrap] 服务已在运行，直接连接 port=', port);
    return true; // 服务已在运行，直接连接
  }
  log('[bootstrap] 端口空闲，开始自动拉起服务');

  updateLoading(`正在启动 DSH 服务（端口 ${port}）…`);
  startDshServer(port, ws, dshBin);
  const ok = await waitForServer(port, START_TIMEOUT_MS);
  log('[bootstrap] 等待服务就绪结果=', ok);
  if (!ok) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DSH 服务启动失败',
      message: `端口 ${port} 在 ${START_TIMEOUT_MS / 1000} 秒内未就绪。`,
      detail: `请查看日志：${path.join(app.getPath('userData'), 'server.log')}`,
    });
    return false;
  }
  return true;
}

function updateLoading(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `(() => { const el = document.getElementById('status'); if (el) el.textContent = ${JSON.stringify(text)}; })()`
    ).catch(() => {});
  }
}

async function openApp() {
  // 远程模式：不启动本地服务，直接连接远程 DSH（如 mini 的隧道）
  const { remoteUrl, remoteToken, port } = appConfig;
  if (remoteUrl) {
    const sep = remoteUrl.includes('?') ? '&' : '?';
    const url = remoteToken ? `${remoteUrl}${sep}token=${encodeURIComponent(remoteToken)}` : remoteUrl;
    updateLoading('正在连接远程 DSH…');
    log('[openApp] 远程模式 →', url);
    mainWindow.loadURL(url);
    return;
  }
  const ok = await bootstrapServer();
  if (!ok) { log('[openApp] bootstrap 失败，停留加载页'); return; }
  updateLoading('服务已就绪，正在打开界面…');
  log('[openApp] 加载界面 http://127.0.0.1:' + port);
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

// ── 应用生命周期 ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    log('[main] argv=', JSON.stringify(process.argv));
    appConfig = loadConfig();
    log('[main] 配置已加载 port=', appConfig.port, 'workspace=', appConfig.workspaceDir, 'lanEnabled=', appConfig.lanEnabled);

    registerIpc();
    createTray();
    registerShortcuts();

    const template = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: '局域网访问…', accelerator: 'CmdOrCtrl+Shift+L', click: () => openLanPanel() },
          { label: '打开配置文件', click: () => shell.openPath(path.join(app.getPath('userData'), 'config.json')) },
          { label: '查看服务日志', click: () => shell.openPath(path.join(app.getPath('userData'), 'server.log')) },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize' },
          { role: 'close' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    createWindow();
    openApp();

    // 若上次退出时开启了局域网访问，恢复代理
    if (appConfig.lanEnabled) {
      startLanProxy().then((ok) => {
        log('[main] 恢复局域网代理:', ok ? '成功' : '失败');
        if (!ok) dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '局域网访问未恢复',
          message: `上次启用的局域网访问未能启动（端口 ${appConfig.lanPort}）。`,
          detail: '可打开「DSH Desktop → 局域网访问…」查看状态。',
        });
      });
    }
  });

  // macOS：点 Dock 图标重新显示窗口
  app.on('activate', () => showWindow());

  // 退出前回收由本应用启动的服务 + 关闭局域网代理 + 注销快捷键
  app.on('before-quit', () => {
    isQuitting = true;
    stopDshServer();
    stopLanProxy();
    globalShortcut.unregisterAll();
  });
}
