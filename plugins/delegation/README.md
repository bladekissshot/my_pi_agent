# pi_agent_delegation_plugin

Pi Delegation 0.1.0 · Pi Agent / Pi Web 扩展源码与维护仓库

可选的双模型协作插件，使用 Pi SDK 执行子任务，通过 Pi Web 原生 Extension Widget 在聊天页内显示任务树。无需修改 Pi Web 源码，也不需要另起统计网站。

## 仓库与维护

本仓库包含委派插件、[主会话 Header 扩展](integrations/pi-agent/README.md)、[Pi Web 的 Mac 启动入口源码](integrations/pi-web/README.md)，以及[配置示例](examples/models.example.json)和[详细 spec 示例](docs/spec-example.md)。上游 Pi Agent/Pi Web 本体未修改。开发、CI、升级流程见[维护说明](docs/MAINTAINING.md)。

```sh
pi install ./plugins/delegation
```

## 使用

在 Pi Web 消息框输入 `/delegation`，会出现原生配置对话框：选择执行模型、开启 AUTO、调整并发上限、显示面板或停止任务。主模型使用消息框下方的 Pi Web 原生模型选择器。输入框附近的 **Delegation · 任务树** 按钮展开统计。

```text
/delegation exec modelhub/deepseek-flash
/delegation repo
/delegation auto
/delegation limit 4
/delegation status
/delegation off
```

模型从当前 Pi 可用且已启用的列表中选择，插件没有固定任何厂商或模型。执行模型变更只影响之后启动的新任务。`/delegation exec` 不带参数时显示选择列表。Pi CLI 还支持 `/delegation main [provider/model]`；Pi Web 0.15 的扩展切换 API 不会同步输入框的模型选择，因此 Web 使用其原生选择器，避免显示与实际请求不一致。

- 新会话默认 OFF；`auto/off` 只影响当前会话，恢复该会话时保留。AUTO 允许主模型选择 0 个子任务，并非每个任务都必须委派。
- 开启 AUTO 时会检查项目的 Git 基线。普通目录或尚无提交的仓库会引导填写仓库地址、确认首次本地提交，完成后继续开启；也可先运行 `/delegation repo [仓库地址]`，或在设置对话框选择“准备 Git 仓库”。
- 执行模型、并发上限和面板偏好会作为新会话默认值；其他已打开会话保持自己的配置。
- OFF 会撤下委派工具并取消尚未启动的任务，已运行的任务继续完成。立即停止用 `/delegation stop <task-id>` 或配置对话框。
- `/delegation panel off` 隐藏树，`/delegation panel on` 重新显示。命令和模型选择不调用 LLM。

## 两种职责

主模型负责理解目标、检查仓库、确定接口、规划、详细 spec、复杂调试、集成与验收。执行模型根据 spec 实现代码或做只读调查；这两类任务共用同一个执行模型，没有第三种模型配置，也不允许递归委派。

插件向主模型注入方法论：小任务直接完成；边界清楚且相互独立时才并行；存在耦合先定接口；缺少信息、重复失败或涉及复杂调试时由主模型处理。模型决定实际任务数，并发上限只是护栏，每个父会话独立计数。

工具：

| 工具 | 用途 |
| --- | --- |
| `delegate_task` | 校验并固化 spec，创建任务，立即返回；可连续派发独立任务 |
| `delegate_status` | 读取任务、工作树、执行报告、真实检查输出与统计；`wait: true` 最多等 30 秒 |
| `delegate_review` | 主模型提供具体审查/集成证据后验收，或标记阻塞 |
| `worker_report` | 仅执行会话拥有；只能提交待审查结果或报告阻塞 |

## Spec 和执行约束

每个 spec 必须包含 `title`、具体 `goal`、必要 `context`、`kind`、`requirements`、`constraints`、明确的 `allowedPaths`、带预期结果的 `acceptance`，可选 `dependencies`。实施任务至少需要一条能运行的检查命令。禁止用整个仓库的通配符代替范围。

插件把 spec 及 SHA-256 保存为独立记录。执行模型可以决定合同内的实现细节；需要改接口或扩大范围时必须报告阻塞，由主模型修改 spec 后创建新任务。执行会话不继承父对话全文，不加载其他扩展、MCP 或 skills，保留仓库上下文文件。父模型应在 spec 中说明关键规则及入口。

执行任务使用 Git worktree 隔离。**不需要用户事先初始化或提交仓库**：

- 已有提交的仓库直接使用，包括没有远程地址的本地仓库；不会自动提交它的未提交修改。
- 没有 Git 仓库或尚无提交时，插件通过 Pi CLI / Pi Web 原生输入框请求仓库地址。已有 `origin` 时复用；Git 用户名、邮箱未配置时会一并询问，仅写入当前仓库。
- 地址必须指向已存在、可访问的远程仓库（也支持本地 Git 仓库绝对路径）。可先在 GitHub 等服务上创建空仓库，再粘贴 HTTPS 或 SSH 地址。插件不代为创建托管平台仓库，也不会推送；认证使用本机 Git 凭据管理器或 SSH 配置。
- 确认项目、地址和文件范围后，空远程会建立首次本地提交；已有远程分支时，获取其历史、补充本地缺少的文件，并以本地同名文件为准创建基线提交。远程包含子模块时，需要先用 Git 完成克隆和子模块初始化。
- 首次提交遵循现有 `.gitignore`；没有该文件时会创建 `node_modules/`、`.pi/`、`.env`、`.env.*`（保留 `.env.example`）、`*.pem`、`*.key` 等忽略项。已有暂存文件仍会进入基线；创建基线前请确认项目自己的忽略范围。
- 取消输入或确认不会开启 AUTO，也不会生成失败子任务。恢复了 AUTO 的会话在首次派发时同样检查；无交互界面的调用会返回 `/delegation repo` 的准备指引，不擅自生成地址。

准备完成后，每个执行任务从启动时的主仓库 HEAD 创建独立分支和工作树：

```text
<仓库相邻目录>/<仓库名>-pi-workers/t-xxxxxxxx
pi-delegation/t-xxxxxxxx
```

父仓库未提交的修改不会复制。主模型应先准备并提交子任务所需基线；依赖任务需要先集成并提交到父仓库，再验收以释放后继任务。验收工具要求记录证据，但不自动证明 Git 集成是否正确，也不会自动合并。

执行模型提交后，插件检查变更范围，独立运行 spec 中的验收命令，再检查一次范围。通过后状态为 **待验收**。主模型必须读取实际 diff、检查结果和集成行为，才能调用 `delegate_review`。代码正确性、测试充分性和业务标准仍需主模型判断。

文件工具对范围和逃逸符号链接进行拦截；运行后检查 tracked/untracked diff。**工作树不是操作系统沙箱**，实施任务的 bash 与检查命令仍具有 Pi 进程的本机权限，忽略文件及外部写入不受 Git diff 全面保护。此插件适用于可信项目的协作约束，不能用来执行不可信代码。只读任务没有 bash/edit/write 工具。

## 统计与恢复

聊天页原生可展开的彩色文字树显示：主模型 → 执行任务、真实模型、运行/验证/等待依赖/阻塞/待验收/已验收状态、输入/输出/缓存 token、执行耗时和阻塞原因。显示最近 12 个任务；完整记录可用 `/delegation status` 查看。它不是任意 React 面板或可拖拽节点图，也不依赖 Pi Web 内置 Agents 抽屉。

- 用量读取 Pi assistant 消息返回的 usage；流式响应结束后结算，不猜测实时 token 或费用。主会话统计包含其已有消息；模型切换后按实际模型分别保留记录。未被提供方返回的计费、父会话压缩等额外请求不在统计内。
- 执行时间包含模型、工具和独立验证；阻塞、排队、等待验收时停止计时。多个并行任务的累计执行时间不等于墙钟时间。主会话计时从插件加载后开始。
- 执行会话禁用自动压缩与 agent 自动重试。默认最多 16 个 assistant 回合、10 分钟，超限或缺少报告时交回主模型。已有报告立即结束执行，无额外“收尾”模型调用。
- 每个执行会话发送自己的 `x-session-affinity`，值为该 Pi session ID。父子关系另存元数据，不复用父会话 ID。
- 正常关闭会中止执行任务；异常重启按最近检查点恢复统计并标记中断，不自动重放可能有副作用的任务。Pi Web liveness 接口用于避免后台任务被当作空闲会话释放。

状态位于 `~/.pi/agent/pi-delegation/`（尊重 `PI_CODING_AGENT_DIR`）：`config.json` 是默认偏好，`runs/` 是父会话状态，`specs/` 是任务书，`sessions/` 是子会话记录。默认目录 0700、数据文件 0600。不要把运行记录和凭据打包发布。

如需调预算，在没有执行任务时编辑 `config.json` 的 `execThinking`（默认 low）、`maxTurns`（2–50）、`taskTimeoutMs`（10000–3600000），之后新会话使用新默认值。并发数可在界面选 1–8。

## 安装、迁移、卸载

需要 Node.js >=22.19、Git、Pi Agent >=1.5.0。本仓库的开发验证基线为 Pi Agent 1.5.2 / Pi Web `@agegr/pi-web@0.17.0`，此前也验证过 1.5.0 / 0.15.0。目标机器自行配置 Pi 模型和密钥。

把发行压缩包解压到长期保留的目录，再安装该目录；macOS/Linux 示例：

```sh
mkdir -p ~/.pi/agent/local-packages/pi-delegation
tar -xzf pi-delegation-0.1.0.tgz -C ~/.pi/agent/local-packages/pi-delegation --strip-components=1
pi install ~/.pi/agent/local-packages/pi-delegation
```

Windows 用同样的流程解压到固定目录，再运行 `pi install C:\path\to\pi-delegation`。路径使用 Node 跨平台 API，但 Windows 的进程树取消语义尚未实机验证。包没有凭据、个人路径或硬编码模型。不要执行 `npm install` 来复制宿主 Pi 依赖；宿主提供 SDK 和 Typebox。

安装/更新后，在空闲时重启 Pi Web 服务并刷新浏览器，或者使用宿主支持的扩展重载。设置执行模型，再在所需会话开启 AUTO。原来的 Mac App 入口无需修改。

卸载先关闭委派并等待/停止任务，再运行 `pi remove <当初安装的目录路径>`，重载宿主。插件不会删除任务工作树。需要清理时先查看 diff、完成集成，再用 `git worktree remove <任务工作树>`（不使用强制参数）；未合并分支和运行记录保留，避免误删成果。

`npm test` 运行无需网络、无需密钥的核心与 Git 初始化测试（使用本地临时仓库）。`npm run test:integration` 使用真实 SDK 与本地模拟服务，包含仓库地址输入、取消、基线确认和随后委派的完整流程；付费提供方验证通过显式启用的 `npm run test:live` 运行。所有测试源码均在 `test/`，仓库不携带本机认证配置。

## 实践来源

采用简明的 orchestrator-workers、明确边界、最少必要上下文、执行检查和独立验收：

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Cursor: Scaling agents](https://cursor.com/blog/scaling-agents)

这些实践不保证每个工程都更省钱。是否委派应比较 spec、协调和验收开销与可并行工作量，结合实际 token 与墙钟时间调整。
