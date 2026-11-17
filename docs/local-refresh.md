# Pi Web 一次性本地刷新

入口：**设置 → 应用 → 检查本地版本并重启**。它不是浏览器 F5，也不下载上游、修改模型或运行 `npm update`；它切换到管理员已登记、已构建的本地 Pi Web/SDK。

## 流程与进程寿命

1. 打开设置、读取版本时不启动管理进程。
2. 点击并确认后，服务器启动一个脱离标准输入输出的一次性 Node 辅助进程，立即返回操作 ID。
3. 辅助进程核对目标构建版本、SDK 和 BUILD_ID，在临时端口、隔离 agent 目录启动目标服务并检查 API 和首页；不提示模型、不读取真实会话。
4. 在线服务再次检查是否空闲，设置短期接入闸门，拒绝新会话、命令和终端，并执行 SDK 的会话关闭钩子。
5. 辅助进程只停止它已核实的旧 Next.js PID，不使用 `taskkill /T` 去杀包含自身的进程树，随后更新本地运行指针并启动目标服务。
6. 新服务的 Web/SDK 版本、BUILD_ID、实例 ID 和首页通过检查后，操作完成，辅助进程退出；网页等到实例变化且操作成功才重新加载。
7. 目标启动失败则恢复旧指针、重新启动旧服务、确认健康后退出；日志说明失败。辅助进程意外退出后，闸门会因进程不在或期限结束失效，避免永久禁用应用。

除 Pi Web 本身的服务进程外，**不保留常驻管理服务、监控器或守护进程**。没有新数据时不会后台轮询管理进程。设置页在一次操作正在进行或等待活动任务结束时轮询状态；空闲时停止。

## 安装

使用 Node.js 24 或更新版本。需要先将包含此功能的源码构建为独立本地版本；不要在正在运行的发布目录中运行 build。构建方法沿用根目录的 `bootstrap`、`build:pi`、`build:web`。发布目录及其 node_modules/SDK 必须长期保留，不要指向一个会被随意重建或清理的目录。

外部 Windows PowerShell 中运行（路径为占位示例）：

```powershell
& 'C:\path\to\checkout\scripts\Install-PiWebLocalRefresh.ps1' `
    -InstallRoot 'C:\path\to\pi-agent' `
    -ReleaseRoot 'C:\path\to\built\projects\pi-web' `
    -TargetRoot 'C:\path\to\built\projects\pi-web'
```

安装器核对构建后，备份已有 `bin/pi-web-launch.cjs` 和管理配置，安装无依赖辅助脚本，写入 `<agentDir>/pi-web-runtime/runtime.json`。**安装器不重启或启动任何服务**。第一次启用需要在任务结束后，用外部终端停止服务，再打开桌面快捷方式；之后即可使用应用 tab。

默认 agentDir 为 `<InstallRoot>/agent`；默认端口 30141。可通过 `-AgentDir`、`-WorkspaceRoot`、`-Port` 覆盖；已有 `pi-web-local.json` 的默认工作目录会保留。环境和桌面启动仍沿用现有安装的脚本，不改变凭证、模型网关、会话或插件设置。

以后有新构建时，在运行时 JSON 中将 `targetRoot` 指向它。`activeRoot` 是当前启动使用的构建，只由成功刷新更新。要重启相同构建，两者可以相同。浏览器不能提交任意路径、命令或 Git 分支。

## 保护与限制

- 仅本机 loopback 页面可用；沿用 Pi Web 的浏览器认证，并拒绝跨来源请求。工作进程的 drain/shutdown 请求还需要随机内部令牌和相同操作/实例 ID，令牌不发给页面，也不传给项目命令和终端。
- 重复点击使用文件系统锁拒绝。服务有运行中的会话、变更命令、启动、扩展对话框、子 Agent、插件后台工作或活动终端时拒绝；检查期间变忙也不强制重启。
- 所有页面会短暂断开；已保存会话继续保留，未发送草稿依赖浏览器已有草稿持久化。请先结束上传、设置保存和其他文件操作，不要把“重启”当作取消操作的按钮。
- 临时检查实例和更新服务都会占用短时间的额外内存/CPU。没有编译或在线下载，不会因为点击进入长时间构建。
- 操作日志和指针备份在 `<agentDir>/pi-web-runtime/`。数据不提交 Git。未通过健康检查的版本不标为成功。
- 现有 CLI 的 status/stop 仍能识别重启后的服务。此入口不改变 Pi CLI 的安装版本，只重启 Web 和它绑定的 SDK。

## 验证

```powershell
npm run test:tooling
```

从本仓库的独立生产构建还可运行：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome' # 或使用已安装的 Playwright Chromium
node projects/pi-web/e2e/local-refresh.mjs
```

该测试自行使用临时端口和独立数据目录，真实点击应用按钮，检查服务实例变化、页面自动加载和辅助 PID 已退出，不触碰正在运行的用户服务。

辅助进程测试包含真实子进程退出、前置检查失败、重复请求、重新启动失败回滚。Web 的 `local-refresh.test.mjs` 和 API 测试覆盖来源、接入闸门、令牌隔离和忙碌保护。构建后的浏览器回归应使用隔离服务验证按钮、忙碌状态以及服务离线/恢复的行为；不要用真实模型任务测试强制停止。
