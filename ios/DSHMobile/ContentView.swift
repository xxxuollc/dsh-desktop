import SwiftUI
import WebKit

/// 主界面：未配置 → 引导页；已配置 → 连接后展示 DSH 客户端界面
struct ContentView: View {
    @EnvironmentObject var config: ConfigStore
    @State private var phase: Phase = .idle
    @State private var showSettings = false

    enum Phase {
        case idle
        case loading
        case ready(URL)
        case error(String)
    }

    var body: some View {
        Group {
            if !config.isConfigured {
                OnboardingView()
            } else {
                content
            }
        }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true // 看任务时屏幕常亮
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }

    private var content: some View {
        ZStack {
            switch phase {
            case .idle, .loading:
                ProgressView("正在连接 Mac…")
                    .task { await connect() }
            case .ready(let url):
                WebViewContainer(url: url)
                    .ignoresSafeArea(.all)
            case .error(let message):
                errorView(message)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { Task { await connect() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44)).foregroundColor(.orange)
            Text("无法连接 DSH").font(.headline)
            Text(message)
                .font(.footnote).foregroundColor(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal)
            Text("请确认：\n· Mac 上 DSH Desktop 的「局域网访问」已开启\n· 手机与 Mac 在同一 Wi-Fi\n· Mac 未休眠")
                .font(.caption).foregroundColor(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal)
            Button("重试") { Task { await connect() } }
                .buttonStyle(.borderedProminent)
        }
        .padding()
    }

    /// 连通性检查（带令牌访问一次），成功后交给 WKWebView 加载
    private func connect() async {
        guard let url = config.connectURL else {
            phase = .error("配置不完整，请重新扫码或检查设置。")
            return
        }
        phase = .loading
        do {
            var request = URLRequest(url: url, timeoutInterval: 8)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200..<400).contains(http.statusCode) {
                phase = .ready(url)
            } else {
                phase = .error("服务器返回了意外状态（\((response as? HTTPURLResponse)?.statusCode ?? -1)）。")
            }
        } catch {
            phase = .error("无法访问 \(url.host ?? "服务器")：\(error.localizedDescription)")
        }
    }
}
