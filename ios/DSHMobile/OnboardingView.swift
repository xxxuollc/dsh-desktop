import SwiftUI

/// 首次启动引导：扫码连接 or 手动输入
struct OnboardingView: View {
    @EnvironmentObject var config: ConfigStore
    @State private var showScanner = false
    @State private var showManual = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "wave.3.right.circle.fill")
                .font(.system(size: 76)).foregroundColor(.cyan)
            Text("DSH Mobile").font(.largeTitle.bold())
            Text("扫码连接 Mac 上的 DSH Desktop\n会话、任务进度与电脑完全同步")
                .font(.subheadline).foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button {
                showScanner = true
            } label: {
                Label("扫描二维码连接", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Button("手动输入服务器地址") { showManual = true }
                .font(.footnote)
                .padding(.bottom, 30)
        }
        .padding(.horizontal, 28)
        .sheet(isPresented: $showScanner) {
            QRScannerView(onScan: handleScan)
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showManual) {
            ManualEntryView()
        }
    }

    private func handleScan(_ url: URL) {
        if config.parseQR(url) {
            showScanner = false
        }
    }
}

/// 手动输入服务器地址 + 令牌
struct ManualEntryView: View {
    @EnvironmentObject var config: ConfigStore
    @Environment(\.dismiss) private var dismiss
    @State private var server = ""
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器地址") {
                    TextField("http://192.168.x.x:3082", text: $server)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section("访问令牌（Mac 局域网面板可查看）") {
                    TextField("令牌", text: $token)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section {
                    Button("保存并连接") {
                        config.config = AppConfig(
                            serverURL: server.trimmingCharacters(in: .whitespaces),
                            token: token.trimmingCharacters(in: .whitespaces)
                        )
                        dismiss()
                    }
                    .disabled(server.isEmpty || token.isEmpty)
                }
            }
            .navigationTitle("手动连接")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
