# Windows 桌面启动器

`scripts/Start-PiWeb.ps1` 保存已验证的桌面启动优化，适用于现有的本地 Pi Agent 安装。它与 `npm run launch:web` 的用途不同：后者从本仓库启动构建产物；桌面脚本复用安装目录中的运行环境和服务入口，不安装依赖、不构建、不迁移数据。

## 安装目录约定

通过 `-InstallRoot` 指定已有安装目录，其布局为：

```text
<install-root>/
  bin/
    PiWeb-Environment.ps1  # 本机环境配置，不进入 Git
    pi-web-launch.cjs      # 已有安装的服务入口
  node/node.exe            # 默认 Node.js 可执行文件
  agent/pi-web-logs/        # 启动时创建，保存 stdout.log / stderr.log
```

环境脚本负责配置已有 agent 数据目录、缓存和其他运行环境；桌面脚本不覆盖模型、插件或会话配置。安装入口和环境配置仍由现有安装提供，此文件不是完整安装器。

从仓库调用（将占位路径替换为实际目录）：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\to\checkout\scripts\Start-PiWeb.ps1" -InstallRoot "C:\path\to\pi-agent"
```

也可以在备份旧文件后，将脚本复制到现有安装的 `bin/Start-PiWeb.ps1`。脚本默认把自身所在目录的父目录作为安装目录，因此原有指向该文件的桌面快捷方式无需调整。复制脚本不会重启正在运行的服务。

可选参数：

- `-Port`：监听端口，默认 `30141`，只使用本机 `127.0.0.1`。
- `-NodePath`：覆盖默认的 `<install-root>/node/node.exe` 路径。
- `-NoBrowser`：仅启动或检查服务，不打开浏览器；失败时输出错误而不弹窗。

## 优化与保护

- 直接读取本机 TCP 监听表，无监听进程时不发送必然失败的 HTTP 请求，避免启动前约 2 秒的超时等待。
- 不再调用 `Get-NetTCPConnection`，避免加载 CIM 查询的额外开销。
- 服务启动后的就绪轮询由 500ms 缩短至 100ms；首页确认成功后不再重复请求。
- 保留首页 HTTP 200 和 Pi Web 标题检查；服务已运行时复用它，端口被其他程序占用或服务异常时报告错误，不终止已有进程。
- 使用按端口命名的互斥锁，避免同时点击造成重复启动；保留启动超时和进程提前退出检测。

原安装在独立端口、空白测试数据目录、文件缓存已预热的条件下，从 PowerShell 启动到首页可用约由 **4.4 秒降至 1.5～1.6 秒**。这是迁移前的本机测量，不是所有设备的性能保证；不包含浏览器打开时间，也不代表电脑重启后的首次启动耗时。

## 验证

```powershell
npm run test:tooling
```

其中 `scripts/start-pi-web.test.mjs` 在 Windows 上使用隔离安装目录、临时端口和本地模拟服务，验证服务复用、端口冲突、异常响应、首次启动、并发启动及带空格的安装路径。不读取用户配置，不加载 Pi SDK，不调用模型；其他系统会跳过这些 Windows 专用用例。
