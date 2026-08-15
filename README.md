# DSH Desktop

将 DSH Web 界面（http://127.0.0.1:3080）封装为 macOS 桌面应用的 Electron 壳。

## 功能

- 常驻 **Dock**：点 Dock 图标显示/恢复窗口；关闭窗口只是隐藏，Cmd+Q 才退出
- **自动拉起服务**：启动时检测端口（默认 3080），无响应则自动运行 `dsh --profile web` 并等待就绪；服务已运行则直接连接
- **服务生命周期管理**：只有“本应用拉起”的服务会在退出时被回收；你手动启动的服务不受影响
- 服务意外退出时弹出提示，可一键重试

## 使用

```bash
npm install          # 安装依赖（如遇 ~/.npm 权限问题，用 --cache 指定项目内缓存）
npm run icon         # 生成图标（可选，assets/icon.png 已生成）
npm run dist         # 打包 .app → dist/mac*/DSH Desktop.app
npm run dist:dmg     # 打包 .app + dmg 安装镜像
```

打包后把 `DSH Desktop.app` 拖进「应用程序」即可，或：

```bash
ditto "dist/mac-arm64/DSH Desktop.app" "/Applications/DSH Desktop.app"
```

> 注：打包产物在 `dist/mac-arm64/`（Apple Silicon）。应用未做代码签名，仅本地使用无碍；
> 若要分发给别人，需要 Developer ID 证书后再打包。

## Releases（GitHub Actions 自动构建）

推送形如 `v1.0.0` 的 tag 会自动触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：

1. 在 macOS runner 上 `npm ci` + 生成图标 + `electron-builder` 打出 **arm64 / x64 两个架构**的 `.app`
2. 压缩为 `DSH Desktop-darwin-arm64.zip` / `DSH Desktop-darwin-x64.zip`
3. 发布为 GitHub Release（含自动生成的更新说明）

下载对应架构的 zip 解压后拖进「应用程序」即可。

> 未签名应用首次打开会被 Gatekeeper 拦截：右键 → 打开 → 确认。若要让别人无感安装，需要
> Developer ID 证书并在工作流中开启 `CSC_LINK` / `CSC_KEY_PASSWORD` 签名。

## 配置

首次运行自动生成 `~/Library/Application Support/DSH Desktop/config.json`：

```json
{
  "port": 3080,
  "workspaceDir": "/Users/<你>/Documents/Herness Space",
  "dshBin": ""
}
```

- `port`：DSH 服务端口（默认 3080）
- `workspaceDir`：服务工作目录（即 agent 的工作区根目录）
- `dshBin`：dsh 可执行文件路径；留空时自动在 `~/.npm/_npx/*/node_modules/.bin/dsh` 中查找最新的

菜单栏「DSH Desktop → 打开配置文件 / 查看服务日志」可快速定位。

覆盖优先级（高→低）：`Resources/dev-config.json` > 命令行参数 > 环境变量 > `config.json` > 默认值。

- 测试用环境变量：`DSH_DESKTOP_PORT` / `DSH_DESKTOP_WORKSPACE` / `DSH_DESKTOP_DSH_BIN`
- 命令行参数（直接执行二进制时）：`--dsh-port=3099` / `--dsh-workspace=...` / `--dsh-home=...`
- 调试覆盖文件：应用包内 `Contents/Resources/dev-config.json`，`{"port": 3099, "home": "/tmp/...", "workspaceDir": "..."}`。
  因 macOS `open --args` 不会把参数传给 Electron 应用，调试时把该文件写进包内即可注入配置。

## 开发

- `npm start`：以开发模式运行（需先手动启动 DSH 服务或依赖自动拉起）
- `scripts/test-server-start.sh`：在隔离的 `DSH_HOME` 下验证 `dsh --profile web` 自动启动路径（端口 3099，不影响线上服务）
- `scripts/gen-icon.js`：纯 Node 生成 1024x1024 占位图标（节点图风格，备用）
- `scripts/make-whale-svg.js` + `scripts/gen-whale-icon.js`：从 DSH 官方 `favicon.svg` 提取鲸鱼路径，
  纯 Node 扫描线光栅化（8x 超采样 + even-odd）合成「浅色圆角底 + 黑鲸」→ `assets/icon.png`（素材 `assets/icon-whale.svg`）
- 日志：`~/Library/Application Support/DSH Desktop/app.log`（应用主进程）、`server.log`（dsh 服务）
- 构建缓存位于项目内 `.npm-cache` / `.electron-cache` / `.builder-cache`（沙箱/权限原因未用系统缓存），确认不需要重新打包时可删除，下次构建会重新下载

## 致谢

- 应用图标中的鲸鱼图案取自 **DeepSeek Harness** 官方 `favicon.svg`（© DeepSeek），
  仅供个人使用，请勿用于商业用途。
