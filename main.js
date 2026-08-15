// DSH Desktop — 将 DSH Web 界面封装为 macOS 桌面应用
// 功能：常驻 Dock；启动时检测 3080 端口，未响应则自动拉起 dsh 服务；退出时回收由本应用启动的服务。
'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DEFAULT_PORT = 3080;
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'Documents', 'Herness Space');
const POLL_INTERVAL_MS = 700;
const START_TIMEOUT_MS = 30_000;

let mainWindow = null;
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
      if (dev.home) process.env.DSH_HOME = dev.home;
      log('[main] 应用调试覆盖 dev-config:', JSON.stringify(dev));
    }
  } catch (e) {
    log('[main] dev-config 读取失败:', e.message);
  }
  // 首次运行：写入默认配置，方便用户日后修改
  if (!fs.existsSync(configPath)) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    } catch (e) {
      console.error('无法写入配置文件：', e.message);
    }
  }
  return cfg;
}

// ── 定位 dsh 可执行文件 ─────────────────────────────────────────────────────
function findDshBin(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  // npx 缓存：~/.npm/_npx/<hash>/node_modules/.bin/dsh，取最新的一个
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  try {
    const dirs = fs.readdirSync(npxRoot)
      .map((d) => path.join(npxRoot, d, 'node_modules', '.bin', 'dsh'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dirs.length) return dirs[0];
  } catch { /* 目录不存在时忽略 */ }
  // 兜底：PATH 常见位置
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
  log('[spawn]', dshBin, args.join(' '), 'cwd=', workspaceDir);
  serverChild = spawn(dshBin, args, {
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

// ── 启动流程 ────────────────────────────────────────────────────────────────
async function bootstrapServer() {
  const { port, workspaceDir, dshBin: configuredBin } = appConfig;
  const dshBin = findDshBin(configuredBin);
  log('[bootstrap] port=', port, 'workspace=', workspaceDir, 'dshBin=', dshBin || '(null)');

  if (!dshBin) {
    log('[bootstrap] 找不到 dsh 可执行文件');
    dialog.showMessageBox({
      type: 'error',
      title: '找不到 dsh',
      message: '未找到 dsh 可执行文件，无法自动启动 DSH 服务。',
      detail: `请先通过 npx @deepseek-ai/dsh 启动过服务，或在配置文件中设置 dshBin 路径。\n配置文件：${path.join(app.getPath('userData'), 'config.json')}`,
    });
    return false;
  }

  if (!fs.existsSync(workspaceDir)) {
    dialog.showMessageBox({
      type: 'error',
      title: '工作目录不存在',
      message: `配置的工作目录不存在：${workspaceDir}`,
    });
    return false;
  }

  if (await isServerUp(port)) {
    log('[bootstrap] 服务已在运行，直接连接 port=', port);
    return true; // 服务已在运行，直接连接
  }
  log('[bootstrap] 端口空闲，开始自动拉起服务');

  updateLoading(`正在启动 DSH 服务（端口 ${port}）…`);
  startDshServer(port, workspaceDir, dshBin);
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
      `document.getElementById('status').textContent = ${JSON.stringify(text)}`
    ).catch(() => {});
  }
}

async function openApp() {
  const ok = await bootstrapServer();
  if (!ok) { log('[openApp] bootstrap 失败，停留加载页'); return; }
  updateLoading('服务已就绪，正在打开界面…');
  const { port } = appConfig;
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
    log('[main] 配置已加载 port=', appConfig.port, 'workspace=', appConfig.workspaceDir);

    const template = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
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
  });

  // macOS：点 Dock 图标重新显示窗口
  app.on('activate', () => showWindow());

  // 退出前回收由本应用启动的服务
  app.on('before-quit', () => {
    isQuitting = true;
    stopDshServer();
  });
}
