# DSH Desktop — 决策记录（NOTES）

> 本文档记录项目演进过程中的分析结论与决策，供后续查阅。时间线从 2026-08 开始。

## 2026-08-17 与 cipherTing/deepseek-harness-desktop-pure 对比结论

**对方概况**：Tauri 2 + 系统 WebView 的 Harness 纯净桌面发行版（3 stars，2026-08 创建）。
零依赖安装（安装包内置 Node.js + Harness 生产闭包）、macOS arm64 dmg + Windows x64 exe、
随机端口只绑 127.0.0.1、fork 上游 + UPSTREAM_COMMIT 纪律、独立 SemVer + 手动 CI。

**对比结论（诚实版）**：
- 它赢在工程成熟度：零依赖安装、Tauri 体积（101MB vs 我们 250MB+）、跨平台、
  UPSTREAM_COMMIT 纪律、安装器分发。
- 我们赢在功能层（它明确"不新增 Harness 功能"）：局域网/远程访问（令牌代理）、
  手机端移动适配层、白屏自愈 + 崩溃取证、SSE 心跳、一键拉起服务。

**我们的定位**：唯一带安全远程访问与跨端体验的 DSH 桌面客户端。
**价值亮点**：① 跨端优先（LAN 代理 + Tailscale/Cloudflare 双门禁远程）② 自愈可靠
③ 移动适配层（代理注入，不碰框架）④ 零依赖安装（对标它的优点，P0 进行中）。

**待办（P0/P1/P2）**：
- P0 零依赖打包（bundle node + dsh 进 Resources/runtime，免用户装 Node）—— 已实现逻辑，构建中遇到问题需修复
- P1 Windows 支持、dmg 安装器
- P2 代码签名 + 公证（$99/年，免 Gatekeeper）、UPSTREAM_COMMIT 记录捆绑 dsh 版本

## 部署架构决策（Mac mini + 极空间 Z2 Pro + Cloudflare）

**方案 A（选定）**：NAS 跑 cloudflared 隧道 + Cloudflare Access 邮箱登录做第一道门，
隧道指向 mini 的 DSH Desktop 令牌代理（3082）；DSH 服务端在 mini 上只绑 127.0.0.1。
公网永远只见 Cloudflare 登录页；双重门禁（邮箱验证 + DSH 令牌）。

```
手机/电脑 → https://dsh.域名.com → Cloudflare Access(登录门) → 隧道(cloudflared, NAS)
  → http://<mini-IP>:3082(令牌代理) → 127.0.0.1:3080(dsh，不碰公网)
```

角色：Mac mini（家庭常开）= DSH 服务器 24/7；极空间 Z2 Pro = 安全入口（永不关机）；
MacBook Pro / iPhone = 客户端（任何网络）。

## 历史关键修复记录（2026-08）

- 局域网代理 lan-proxy.js：令牌门禁 + Host/Origin 重写（过 dsh 信任围栏）
- lan-inject.js：HTML 注入（randomUUID 补丁[不安全上下文必需] + 移动适配层 + SSE 心跳）
- 移动端：滑动开合侧栏、聊天全宽、16px 防缩放、44px 触控、设置单列、输入坞安全区
- 白屏自愈：console 错误取证 + 自动 reload + 崩溃日志（page-err）
- 教训：① 编译产物不可手改（破坏 __ModuleLoader__ 注册）② master(rc.5)≠线上(rc.6) 版本漂移
  ③ 过夜任务不可依赖需人工审批的操作（权限墙）④ 无视觉验证的 CSS 覆盖有黑屏风险
