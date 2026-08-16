import Foundation
import Combine

/// 连接配置：Mac 上 DSH Desktop 的局域网地址 + 访问令牌
struct AppConfig: Codable, Equatable {
    var serverURL: String = ""   // 例: http://192.168.3.100:3082
    var token: String = ""
}

/// 配置存储（UserDefaults），全局共享
final class ConfigStore: ObservableObject {
    static let shared = ConfigStore()

    @Published var config: AppConfig {
        didSet { save() }
    }

    private let key = "dsh.config.v1"

    private init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let c = try? JSONDecoder().decode(AppConfig.self, from: data) {
            config = c
        } else {
            config = AppConfig()
        }
    }

    var isConfigured: Bool {
        !config.serverURL.isEmpty && !config.token.isEmpty
    }

    /// 带上令牌的完整访问 URL（代理校验 ?token= 后种 cookie）
    var connectURL: URL? {
        guard var comps = URLComponents(string: config.serverURL) else { return nil }
        comps.queryItems = [URLQueryItem(name: "token", value: config.token)]
        return comps.url
    }

    /// 解析 Mac 二维码（http://ip:port/?token=xxx）
    func parseQR(_ url: URL) -> Bool {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = comps.host else { return false }
        let token = comps.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
        guard !token.isEmpty else { return false }
        comps.queryItems = nil
        var server = "http://\(host)"
        if let port = comps.port { server += ":\(port)" }
        config = AppConfig(serverURL: server, token: token)
        return true
    }

    private func save() {
        if let data = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
