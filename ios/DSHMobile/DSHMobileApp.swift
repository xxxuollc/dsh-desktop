import SwiftUI

@main
struct DSHMobileApp: App {
    @StateObject private var config = ConfigStore.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(config)
        }
    }
}
