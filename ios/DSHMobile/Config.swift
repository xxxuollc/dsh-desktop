import Foundation
import Combine

/// 连接配置：默认直连云端 DSH（mini 的隧道域名），打开即用
struct AppConfig: Codable, Equatable {
    var serverURL: String = DEFAULT_SERVER
    var token: String = DEFAULT_TOKEN
}

/// 默认服务器（mini 的 Cloudflare 隧道）+ 访问令牌
let DEFAULT_SERVER = "https://dsh.assayer.top"
let DEFAULT_TOKEN = "teYJpAWtRZLJcVKHc3ptIw"

/// 配置存储（UserDefaults），全局共享
final class ConfigStore: ObservableObject {
    static let shared = ConfigStore()

    @Published var config: AppConfig {
        didSet { save() }
    }

    // v2：默认值改为云端域名；v1 里的旧局域网地址不再读取
    private let key = "dsh.config.v2"

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
