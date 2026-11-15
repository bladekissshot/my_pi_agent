# Pi Prompt Manager

管理不同任务的 system prompt 模板，并把正文和版本固定到会话。模板编辑、删除、切换默认项，不会修改已绑定的会话。恢复、重载、切换模型/工具和分叉时继续使用原快照。

## Pi CLI

交互式新会话在开始前选择模板；取消选择使用当前默认项。已有会话不再弹出选择器。

```powershell
pi --prompt-profile general
pi --prompt-profile default
```

- `/prompts`：打开创建、编辑、删除和新会话默认设置菜单。
- `/prompts list`：列出模板与 id。
- `/prompts current`：查看当前固定版本。
- `/prompts use <id>`：设置之后的新会话默认项。
- `/prompts use default`：之后的新会话不使用托管模板。

## Pi Web

配合本地 Pi Web 补丁，在“系统”tab 中创建、查看、编辑、删除模板，并“启用于新会话”。面板同时显示当前会话固定的名称、版本和正文；没有修改当前绑定的操作。

开启空白会话的系统 tab 不会提前建立运行时，因此可以先选择模板再发起任务。也支持 `POST /api/agent/new` 中的 `promptProfileId` 为单个新会话指定模板。此参数不能修改已有会话。

## 数据和一致性

共享目录是 Pi 的 agent directory 下的 `prompt-manager/`：

- `catalog.json`：模板、版本和之后的新会话默认项。
- `sessions/<session-id>.json`：不可重绑定的会话快照。
- 会话 JSONL 的 `pi-prompt-manager:binding:v1` custom entry：随会话保存和分叉携带的快照。

首次初始化将原有 `APPEND_SYSTEM.md` 导入为“通用工程”，不会删改原文件。已有记录的旧会话从其 system message 的 addendum 恢复原正文，而不取当前默认模板。项目单独的追加说明仍保存到快照；工具声明、AGENTS.md 和 skills 按 Pi 原生方式加载。只固定模板层，不冻结工具列表。

编辑和删除要求正确的版本号，多个窗口修改同一模板时返回冲突，防止旧草稿覆盖新内容。会话快照使用原子创建，并发启动同一会话也只有一个选择生效。模板被删除，已有快照仍可读。损坏或冲突的快照会拒绝继续，而不会偷偷切换默认项。

“追加”模式保留 Pi 原生说明。“替换”模式按明确选择使用完整正文（可以为空）；已有委派和其他扩展的任务合同仍需遵守。内置 subagent 和当前委派 worker 继续使用自己的角色提示词，不替换其任务合同。

## 安装和验证

将此本地包加入共享 `settings.json` 的 `packages`，放在委派等追加提示词的插件之前。Pi Web 补丁使用本包的同一数据层，需要在 Web 的依赖中安装本包，并构建 Web 界面。普通插件无法向现有系统 tab 添加管理界面。

此插件可从本仓库的 `plugins/prompt-manager` 安装。Web 补丁位于 `projects/pi-web`；构建、测试和同步方法见仓库根 README。运行时数据保持在仓库之外。

```powershell
npm test
```

包含 CRUD、默认切换、旧会话恢复、删除保留、分叉、并发创建、项目说明、冲突与真实 Pi SDK 的重载/模型/工具切换检查。SDK 集成测试通过包解析器加载 Pi，在请求模型前中止。
