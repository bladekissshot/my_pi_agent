# my_pi_agent

一个维护 Pi、Pi Web 和独立插件的个人 monorepo。两套上游使用 Git subtree 快照分别同步，本地修改提交在各自目录中。

- `projects/pi/`: the complete Pi upstream toolkit.
- `projects/pi-web/`: Pi Web and local UI/runtime integrations.
- `plugins/`: independently reusable Pi packages.
- `scripts/`: upstream synchronization, verification and local build orchestration.
- `upstreams.lock.json`: reviewed upstream versions and commits.

当前上游基线：Pi 1.5.2、Pi Web 0.17.0（最初导入为 Pi 1.5.0、Pi Web 0.15.0）。当前本地修改见 [docs/local-changes.md](docs/local-changes.md)。完整上游版本、commit 和子树快照记录在 `upstreams.lock.json`。本次升级的适配、验证及运行注意事项见 [docs/upstream-2026-11.md](docs/upstream-2026-11.md)。

## 构建和验证

使用 Node.js 24 或更新版本，包括 npm 的子进程：

```sh
npm run bootstrap
npm run build:pi
npm test
npm run check:web
npm run build:web
```

两个上游保留各自的构建布局和锁文件。`bootstrap` 显式安装开发依赖，即使从 Pi Web 的生产进程启动也会使用锁定的编译器与测试工具。`build:pi` 构建本仓库的 Pi，并把 Web 和插件的 SDK 解析指向这套本地包，避免 CLI 与 Web 使用不同的 Pi。普通测试使用隔离目录和模拟服务，不会调用你的模型网关。

首次构建的模型数据取自相同版本的公开 Pi npm 包，再由上游校验器检查，避免构建时必须获取实时模型目录。需要更新目录时可按 Pi 上游的生成流程显式更新。

## 分别同步上游

```sh
npm run sync:pi -- v1.5.2
npm run sync:pi-web -- v0.17.0
```

示例中的 tag 换成要同步的版本。脚本要求工作区干净，会补齐对应 remote、创建 `codex/sync-*` 分支、合并一个子树并更新版本记录。已在当前版本则不创建分支。冲突保留供你解决，脚本不会自动合并到 main 或推送。同步后运行相关检查，再集成该分支。

## 本地运行

把 `examples/local.runtime.example.json` 复制到 `.local/runtime.json`，填入你自己的 agent 数据目录和可选工作目录。该文件被 Git 忽略，原来的认证、模型配置和会话继续留在数据目录。

```sh
npm run launch:cli -- --prompt-profile general
npm run launch:web
```

Web 只监听 loopback；若端口已有服务会拒绝重复启动。需要先完成对应构建。插件也可从 `plugins/` 子目录独立安装；`plugins/prompt-manager/presets/general.md` 是可选的通用提示词源码。

已有 Windows 本地安装可使用优化后的[桌面启动器](docs/windows-desktop-launcher.md)：`scripts/Start-PiWeb.ps1`。它复用安装目录的环境和服务入口，省去启动前无监听端口上的 HTTP 超时等待，并保留服务复用、并发启动锁及端口冲突保护；不替代上述源码构建启动流程。

已有本地安装还可启用[一次性本地刷新](docs/local-refresh.md)：在“设置 → 应用”检查已登记构建并重启服务，辅助进程在成功或回滚后退出，不常驻；第一次接入仍需外部终端重启。

## 提交检查

```sh
npm run audit:public -- --history
```

本地还可加 `--private-dir <agent-directory>`：从本机认证和模型配置读取私有值的指纹，检查当前文件及可达 Git 历史，只输出规则与文件位置，不打印值。凭证、私有网关 URL、运行时目录、构建产物和 node_modules 不进入仓库。公开的上游仓库地址、软件文档 URL 和占位示例保留。
