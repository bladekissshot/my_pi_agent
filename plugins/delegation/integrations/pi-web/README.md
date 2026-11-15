# Pi Web 集成与 Mac 启动入口

Web 内嵌面板的源码在根目录 `extensions/delegation.ts`，使用 `ctx.ui.setWidget()`；后台会话保活使用 Pi Web 的 `@agegr/pi-web/session-liveness/v1` 注册接口。没有修改 Pi Web 的 React 页面或服务源码。主模型使用 Pi Web 原生模型选择器。

`macos/` 是实际部署的浏览器启动入口源码：检查本机 `127.0.0.1:30141`，按需通过 launchd 启动 Pi Web，然后打开默认浏览器并退出。不会创建原生聊天窗口，也不会设置登录自启动。

## 构建

在 macOS 安装 Xcode Command Line Tools 后，从仓库根目录运行：

```sh
bash scripts/build-macos.sh
```

产物是 `dist/Pi Web.app`，脚本只构建，不覆盖已安装应用。需要安装时，把构建产物复制到 Applications。应用按当前机器架构编译，使用本机 ad-hoc 签名，未公证。

当前启动器沿用已部署的 Apple Silicon Homebrew 路径 `/opt/homebrew/bin/{node,pi,pi-web}`。换用 Intel Mac 或其他安装前缀时，先修改 `PiWeb.swift` 中对应路径再构建。插件本身不依赖此路径。

安装匹配的上游版本：

```sh
npm install -g @earendil-works/pi-coding-agent@1.5.0 @agegr/pi-web@0.15.0
```

启动器按当前用户生成 `~/Library/Application Support/Pi Web/server.plist`，日志写入 `~/Library/Logs/Pi Web/server.log`。机器专属 plist、编译后的二进制与凭据不纳入 Git。

上游：[agegr/pi-web](https://github.com/agegr/pi-web)。启动入口遵守本仓库 MIT 许可证；上游项目保留自己的许可与版权。
