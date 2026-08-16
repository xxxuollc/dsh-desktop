import SwiftUI

/// 设置：查看/修改服务器地址与令牌、清除配置重新扫码
struct SettingsView: View {
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
                Section("访问令牌") {
                    TextField("令牌", text: $token)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section {
                    Button("保存并重新连接") {
                        config.config = AppConfig(
                            serverURL: server.trimmingCharacters(in: .whitespaces),
                            token: token.trimmingCharacters(in: .whitespaces)
                        )
                        dismiss()
                    }
                    Button("清除配置（重新扫码）", role: .destructive) {
                        config.config = AppConfig()
                        dismiss()
                    }
                }
                Section(footer: Text("手机与 Mac 需在同一 Wi-Fi；Mac 上 DSH Desktop 的「局域网访问」需保持开启。")) {
                    EmptyView()
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                server = config.config.serverURL
                token = config.config.token
            }
        }
    }
}
