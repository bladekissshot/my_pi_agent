import AppKit

final class PiWebLauncher: NSObject, NSApplicationDelegate {
    private let address = URL(string: "http://127.0.0.1:30141")!
    private let label = "local.agegr.pi-web"
    private let home = FileManager.default.homeDirectoryForCurrentUser

    func applicationDidFinishLaunching(_ notification: Notification) {
        checkHealth { ready, occupied in
            if ready { self.openBrowser() }
            else if occupied { self.fail("端口 30141 已被其他服务占用。请释放该端口后重试。") }
            else { self.startService() }
        }
    }
    private func checkHealth(_ completion: @escaping (Bool, Bool) -> Void) {
        var request = URLRequest(url: address.appendingPathComponent("manifest.webmanifest"))
        request.timeoutInterval = 1
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let ready = (response as? HTTPURLResponse)?.statusCode == 200 && payload?["name"] as? String == "Pi Web" && payload?["description"] as? String == "Local web interface for the pi coding agent"
            DispatchQueue.main.async { completion(ready, response != nil) }
        }.resume()
    }
    @discardableResult private func launchctl(_ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
    private func startService() {
        do {
            guard FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/node"), FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/pi"), FileManager.default.isExecutableFile(atPath: "/opt/homebrew/bin/pi-web") else {
                fail("找不到本机 Node.js、pi 或 @agegr/pi-web，请检查本地源码构建和全局命令链接。"); return
            }
            let support = home.appendingPathComponent("Library/Application Support/Pi Web", isDirectory: true)
            let logs = home.appendingPathComponent("Library/Logs/Pi Web", isDirectory: true)
            let workspace = home.appendingPathComponent("Documents/Pi", isDirectory: true)
            for path in [support, logs, workspace] { try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true) }
            let plist = support.appendingPathComponent("server.plist")
            let settings: [String: Any] = [
                "Label": label,
                "ProgramArguments": ["/opt/homebrew/bin/node", "/opt/homebrew/bin/pi-web", "--hostname", "127.0.0.1", "--port", "30141", "--no-open"],
                "WorkingDirectory": workspace.path,
                "EnvironmentVariables": ["SHELL": "/bin/zsh", "LANG": "en_US.UTF-8", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "PI_CODING_AGENT_DIR": home.appendingPathComponent(".pi/agent").path],
                "RunAtLoad": true,
                "KeepAlive": true,
                "ProcessType": "Background",
                "StandardOutPath": logs.appendingPathComponent("server.log").path,
                "StandardErrorPath": logs.appendingPathComponent("server.log").path
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: settings, format: .xml, options: 0)
            try data.write(to: plist, options: .atomic)
            let domain = "gui/\(getuid())"
            if try launchctl(["print", "\(domain)/\(label)"]) == 0 {
                guard try launchctl(["kickstart", "\(domain)/\(label)"]) == 0 else { fail("无法启动 Pi Web 后台服务。"); return }
            } else {
                guard try launchctl(["bootstrap", domain, plist.path]) == 0 else { fail("无法注册 Pi Web 本地服务。请查看 ~/Library/Logs/Pi Web/server.log。"); return }
            }
            waitForService(attempts: 80)
        } catch { fail("启动 Pi Web 失败：\(error.localizedDescription)") }
    }
    private func waitForService(attempts: Int) {
        checkHealth { ready, _ in
            if ready { self.openBrowser() }
            else if attempts > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForService(attempts: attempts - 1) } }
            else { self.fail("Pi Web 启动超时。日志位于 ~/Library/Logs/Pi Web/server.log。") }
        }
    }
    private func openBrowser() {
        if NSWorkspace.shared.open(address) { NSApp.terminate(nil) }
        else { fail("无法打开默认浏览器。请手动访问 http://127.0.0.1:30141。"); }
    }
    private func fail(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Pi Web 启动入口"
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        NSApp.terminate(nil)
    }
}
let app = NSApplication.shared
let delegate = PiWebLauncher()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
