# DSH Desktop

把 DSH（DeepSeek Harness）Web 界面封装成 **macOS 桌面应用**：常驻 Dock、双击即用、自动拉起服务。

**它是什么**：一个 Electron「壳」。真正干活的是 DSH 服务端（npm 包 `@deepseek-ai/dsh`），
桌面应用负责：检测/启动服务 → 打开界面 → 管理服务生命周期。

**桌面原生能力（v1.1.0）**：
- **托盘常驻**：菜单栏鲸鱼图标，右键快速显示/隐藏窗口、打开局域网面板、退出
- **全局快捷键**：`Cmd+Shift+D` 任意界面唤起窗口
- **局域网多端访问**：扫码让手机/平板连上同一台 DSH（见下文）

---

## 快速开始（普通用户，推荐）

> 只需要两步：**下载 .app** + **装 dsh**。**不需要**去 GitHub 拉任何源码。

**前置要求**：已安装 [Node.js](https://nodejs.org/)（LTS 即可）。

1. **下载应用**：到 [Releases](https://github.com/xxxuollc/dsh-desktop/releases) 下载对应架构的 zip
   - Apple Silicon（M1/M2/M3/M4…）→ `DSH Desktop-darwin-arm64.zip`
   - Intel → `DSH Desktop-darwin-x64.zip`
2. **安装**：解压，把 `DSH Desktop.app` 拖进「应用程序」。
   首次打开如被 Gatekeeper 拦截：右键 → 打开 → 确认打开
3. **安装 DSH 服务端**（打开「终端」执行一条命令）：
   ```bash
   npm install -g @deepseek-ai/dsh
   ```
4. **启动应用**：双击 DSH Desktop。它会自动：
   - 检测 `http://127.0.0.1:3080` 是否有服务在跑 → 没有就自动运行 `dsh --profile web` 拉起（首次会自动初始化）
   - 等服务就绪 → 自动打开界面
5. **首次使用**：在界面里配置模型/API 凭据（设置页）

> 打不开？看菜单「DSH Desktop → 查看服务日志」；或确认 `dsh` 命令在终端里 `command -v dsh` 有输出。

---

## 原理（它到底在做什么）

```
┌─────────────── DSH Desktop（Electron 壳）───────────────┐
│  启动 → 检查 3080 端口                                    │
│    ├─ 已有服务在跑 → 直接连接（不重复启动）                 │
│    └─ 没服务 → spawn `dsh --profile web`（自动拉起）        │
│         → 轮询等就绪 → 加载 http://127.0.0.1:3080          │
│  退出 → 只回收"由本应用启动"的服务，手动启动的不动           │
└──────────────────────────────────────────────────────────┘
```

- **DSH 服务端 ≠ 源码**：`dsh` 是 npm 包 `@deepseek-ai/dsh` 提供的命令行工具（公开包，`npm install -g` 即装）。
  应用启动时按以下顺序查找 `dsh`：
  1. 配置文件 `config.json` 里手动指定的 `dshBin`
  2. npx 缓存（`~/.npm/_npx/*/node_modules/.bin/dsh`）
  3. PATH（`command -v dsh`，覆盖 npm 全局安装 / nvm / volta / Homebrew 等）
  4. 常见固定路径（`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`）
- **首次运行自动初始化**：`dsh --profile web` 首次启动会从内置模板自动创建 profile，无需手动配置
- **配置文件**（首次运行自动生成）`~/Library/Application Support/DSH Desktop/config.json`：
  ```json
  { "port": 3080, "workspaceDir": "/Users/<你>", "dshBin": "", "lanEnabled": false, "lanPort": 3082 }
  ```
  菜单「DSH Desktop → 打开配置文件 / 查看服务日志」可快速定位
- **工作目录**（`workspaceDir`）= agent 的工作区根目录；不存在时会自动回退到主目录并提示

---

## 局域网多端访问（v1.1.0）

同一 Wi-Fi 下的手机/平板扫码即可使用同一台 DSH，**会话、任务、历史完全同步**（服务端单点，谁连谁接续）。

菜单「DSH Desktop → 局域网访问…」（或 `Cmd+Shift+L`）打开面板：

- **一键开启**：壳进程启动一个**带令牌门禁的代理**（默认端口 `3082`），二维码形如
  `http://<局域网IP>:3082/?token=<16字节随机令牌>`
- 手机相机扫码 → 首次访问种下 HttpOnly cookie → 之后同源请求自动放行
- 面板可查看/复制/重置令牌

### 安全设计（重要）

- **不触碰框架的 `--host 0.0.0.0` 禁令**：DSH 服务端始终只绑定 `127.0.0.1`
  （框架作者刻意禁止全网绑定，因为 Web UI 能执行命令 = RCE 风险）
- 局域网暴露的是**壳进程的代理**，代理层校验令牌；无令牌一律 403
- 代理转发时重写 `Host`/`Origin` 头，通过 dsh 的浏览器信任围栏（防 DNS rebinding）
- ⚠ **令牌即访问权限**（扫码者可操作本机 DSH、能执行命令），只给信任的人；
  令牌在 URL 中会出现在浏览器历史，介意的话用后可在面板重置
- 跨网络访问（人在外面连家里的机器）需要认证 + 隧道，属于后续版本（v1.2+）能力

---

## 修改 DSH 框架源码（开发者）

桌面应用只是启动器，框架代码在 `@deepseek-ai/dsh` 包（或其依赖的 `@deepseek-ai/dsh-*` 插件包）里。
改完**重启应用**即生效（应用每次启动都会重新拉起服务）。

- **只改配置/开关插件（不动源码）**：编辑 `~/.dsh/cordis.patch.yml`（home 级补丁层，可覆盖/禁用/插入插件配置）
- **改框架源码**：
  1. `git clone https://github.com/deepseek-ai/deepseek-harness`
  2. 修改 TS 源码 → 按仓库文档构建出 `dsh` 可执行文件
  3. 把 `config.json` 的 `dshBin` 指向构建产物 → 应用自动改用你的定制版

---

## 从源码构建（开发者）

```bash
npm install          # 安装依赖（electron + electron-builder）
npm run icon         # 生成图标（assets/icon.png）
npm run dist         # 打包 .app → dist/mac-arm64/（本机架构）
npm run dist:dmg     # 额外生成 dmg 安装镜像
npm start            # 开发模式直接运行（需 dsh 可用）
```

## GitHub Actions 自动发布

推送 `v*` 格式的 tag（如 `v1.0.1`）自动触发 [.github/workflows/release.yml](.github/workflows/release.yml)：
macOS runner 上 `npm ci` → 生成图标 → `electron-builder` 打出 **arm64 + x64** 双架构 → 压缩 → 发布 Release。

## 配置项一览

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3080` | DSH 服务端口 |
| `workspaceDir` | 主目录 | 服务工作目录（agent 工作区根目录） |
| `dshBin` | 自动查找 | dsh 可执行文件路径（留空自动查找） |

覆盖优先级（高→低）：`Resources/dev-config.json`（调试）> 命令行参数 > 环境变量 > `config.json` > 默认值。

## 开发细节

- 日志：`~/Library/Application Support/DSH Desktop/app.log`（应用主进程）、`server.log`（dsh 服务）
- `scripts/test-server-start.sh`：隔离 `DSH_HOME` 下验证 `dsh --profile web` 自动启动路径（端口 3099，不影响线上服务）
- `scripts/gen-icon.js`：纯 Node 生成占位图标（备用）
- `scripts/make-whale-svg.js` + `scripts/gen-whale-icon.js`：从 DSH 官方 `favicon.svg` 提取鲸鱼路径，
  纯 Node 扫描线光栅化（8x 超采样 + even-odd）合成「浅色圆角底 + 黑鲸」→ `assets/icon.png`
- 构建缓存位于项目内 `.electron-cache` 等（沙箱/权限原因未用系统缓存），不需要重新打包时可删除

## 致谢

- 应用图标中的鲸鱼图案取自 **DeepSeek Harness** 官方 `favicon.svg`（© DeepSeek），仅供个人使用，请勿用于商业用途。
