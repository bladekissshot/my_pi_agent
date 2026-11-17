# macOS 本地构建与升级

使用 Node.js 24 或更新版本。在 Apple Silicon macOS 上，Pi 自带的 Darwin ARM64 原生模块和 Pi Web 的 node-pty 预编译模块可直接加载，不需要 Windows PowerShell 启动脚本。

## 保留数据

升级前备份 `~/.pi/agent`，包括 `skills/`、认证、模型配置、扩展、提示词和会话。源码构建与 npm 全局链接只更新程序；不要删除 agent 数据目录。已有全局安装和桌面启动器也应备份，以便回退。

## 构建

在仓库根目录运行：

```sh
npm run bootstrap
npm run build:pi
npm test
npm run check:web
npm run build:web
```

`bootstrap` 不执行依赖安装钩子。若某个 node-pty 版本的 `spawn-helper` 缺少执行权限，可运行仓库已有的修正脚本，再验证实际终端启动：

```sh
node projects/pi-web/bin/prepare-terminal.js
```

Web 的 Next.js 和 eslint-config-next 固定为 16.4.6，包含 16.4.5 的 GHSA-mfr8-8qww-v76h 等安全修复，以及路由响应自动压缩。16.4.5 起会移除路由手工设置的 `Content-Encoding`；原来的 `jsonResponse` 手工 gzip 会导致长会话解码失败。现在由 Next.js HTTP 服务统一协商压缩，路由返回原始 JSON。生产模式 E2E 覆盖 gzip 和 identity 两种请求的长会话读取，后续升级也应保留此检查。

## 使用本地程序

复制 `examples/local.runtime.example.json` 到被忽略的 `.local/runtime.json`，将 `agentDir` 设为现有 agent 目录的绝对路径。`workspaceRoot` 留空可保留原来的 `~/pi-cwd/YYYYMMDD` 默认工作目录。

在现有 `settings.json` 中保留其它设置，将本仓库 `plugins/prompt-manager` 的绝对路径加入 `packages`，放在委派插件之前。若使用委派插件，将旧包路径替换为本仓库 `plugins/delegation` 的绝对路径；保留原来的插件数据和其它包。

构建完成后，可以从仓库根目录将两个全局命令链接到源码：

```sh
npm install --global --ignore-scripts ./projects/pi/packages/coding-agent ./projects/pi-web
pi --version
pi-web --version
```

此后 `pi`、`pi-web` 与 Web 内部 SDK 使用同一份本地构建。不要使用 `pi update self`、`pi-web update` 或重新安装 npm 发布包更新这个定制版本；应更新源码、重新构建并验证。

## macOS 桌面入口

已验证的启动器源码保存在 `scripts/macos/PiWeb.swift`，供 Apple Silicon 上使用 Homebrew 默认路径 `/opt/homebrew/bin` 的已有安装使用。它只在 macOS 上手动编译，不参与 `bootstrap`、`build:pi`、`build:web` 或 Windows 启动流程。安装 Xcode Command Line Tools 后可构建：

```sh
mkdir -p .local/macos
xcrun swiftc scripts/macos/PiWeb.swift -framework AppKit -o .local/macos/PiWeb
```

这是已有 Pi Web.app 的入口程序源码，不是完整 app 安装器。备份已有 app 后，用生成的程序替换其 `Contents/MacOS/PiWeb`，再对该 app 执行本地代码签名。Info.plist、图标及生成的 app 保留在本机。Intel Mac 或非默认 Homebrew 路径需先调整源码中的 Node.js 和全局命令路径。

已有的 Pi Web.app 可继续通过全局 `pi-web` 命令启动服务。在 launchd 的 `EnvironmentVariables` 中设置 `PI_CODING_AGENT_DIR`、包含 Node.js 的 `PATH`、`SHELL=/bin/zsh` 和 UTF-8 locale；后台服务不会自动继承终端的 shell 环境。桌面启动器若会重新生成 plist，也需同步这些值。

只监听 `127.0.0.1:30141`。切换前确认没有正在运行的会话，再重启对应 launchd 服务。验证首页、skills 列表、模型列表、历史会话和终端输入输出，并核对升级前后的 skills 文件校验值。

## Windows 兼容性

Windows 继续使用 `scripts/Start-PiWeb.ps1` 和原有 Node.js 构建脚本。共享 JSON 响应修复通过标准 Web API 和 Next.js 处理压缩，不依赖 zsh、launchd 或 macOS 路径；锁文件同时保留 Windows x64、ARM64 等平台的原生依赖。GitHub Actions 在 Windows 和 Linux 上执行源码构建、项目回归及生产模式浏览器测试，Windows 桌面启动器另有专用测试。
