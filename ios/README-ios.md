# DSH Mobile（iOS）

iPhone 原生 App：**扫码连接 Mac 上的 DSH Desktop**，与电脑共享同一个 DSH 服务端——
会话、任务进度、执行状态、双向对话**完全同步**（数据都在 Mac 服务端，手机只是远程客户端）。

- 不是网页：独立 App（主屏图标、全屏、无浏览器边框），内部用 WKWebView 加载 DSH 客户端界面，
  与桌面 DSH Desktop 显示**完全一致**的 UI（同一套客户端）
- 需要 **iPhone iOS 18+**（DSH 流式输出依赖 Safari/WebKit 的 fetch streaming）

## 前提

- Mac：Xcode 16+（App Store 免费安装）、[xcodegen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）
- iPhone：iOS 18+，与 Mac 同一 Wi-Fi
- Apple ID（免费即可，7 天签名；$99/年可 TestFlight/上架）

## 构建安装

```bash
cd ios
xcodegen generate          # 由 project.yml 生成 DSHMobile.xcodeproj
open DSHMobile.xcodeproj
```

在 Xcode 中：
1. 左侧选中 DSHMobile target → Signing & Capabilities
2. 勾选 Automatically manage signing → 选择你的 Team（用 Apple ID 登录后出现）
3. 顶部选择你的 iPhone 设备（需先用数据线连接并信任）
4. Cmd+R 运行

首次启动：允许相机权限 → 扫 Mac 上「DSH Desktop → 局域网访问」的二维码 → 自动连接。

> 免费账号构建的 App 7 天后需重新在 Xcode 里 Run 一次续签；正式分发（TestFlight / App Store）
> 需要 Apple Developer Program（$99/年）。

## 工作原理

```
iPhone DSH Mobile (WKWebView) ──扫码──> Mac 局域网代理 :3082（令牌门禁）
                                              │ 转发（Host/Origin 重写，信任围栏放行）
                                              ▼
                                    Mac 本机 dsh 服务端 :3080  ← DSH Desktop 也连它
```

- 连接前 App 会带令牌探测一次（200 即通），失败给出排查提示
- WKWebView 持久化 cookie（令牌续访），断线后点刷新重连
- 观看任务时屏幕常亮（`isIdleTimerDisabled`）

## 目录

```
ios/
  project.yml            # xcodegen 工程定义
  DSHMobile/
    DSHMobileApp.swift   # 入口
    Config.swift         # 服务器地址/令牌存储 + 二维码解析
    ContentView.swift    # 连接状态机 + 错误兜底
    OnboardingView.swift # 首次引导（扫码/手动）
    QRScannerView.swift  # AVFoundation 扫码
    WebViewContainer.swift # WKWebView 容器
    SettingsView.swift   # 设置（改地址/令牌/清除配置）
    Info.plist           # ATS 局域网例外 + 相机权限
    Assets.xcassets/     # 应用图标（1024 全出血鲸鱼）
```

## 限制与后续

- **跨网络**（人在外面连家里）：需要 P1 的认证 + 隧道（Tailscale/云部署），当前仅限同一 Wi-Fi
- **iOS 18 以下**：页面可开但流式输出不工作
- 原生推送通知（任务完成提醒）：需要服务端接 APNs，属于更后续的框架级改造
