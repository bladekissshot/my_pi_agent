# Pi 1.5.2 / Pi Web 0.17.0 同步记录

## 上游基线

| 项目 | 原版本 | 同步版本 | 上游 commit |
| --- | --- | --- | --- |
| Pi | 1.5.0 | 1.5.2 | `b4afdddf44e059c67ccf5097e5317d913521b470` |
| Pi Web | 0.15.0 | 0.17.0 | `174bff967807cdb59abb0204198d3d7cc19c862d` |

Pi Web 0.17.0 是本次查询时 GitHub 和 npm `latest` 一致的稳定版，发布于 2026-11-14。它将全部 Pi 包固定为 1.5.2，因此两个子树依次同步，不让 Web 和本地 CLI 使用不同 SDK。Pi 按官方 tag 同步完整子树，包含 Chord 等其它工作区的上游更新，并非只替换 node_modules。

- [Pi Web 发布说明](https://github.com/agegr/pi-web/releases/tag/v0.17.0)
- [Pi 1.5.2 源码](https://github.com/earendil-works/pi/tree/v1.5.2)
- 精确版本及 subtree 快照仍以 `upstreams.lock.json` 为准。

## 本地适配

- `useAgentSession.ts`：保留本地提交后自动滚动和 50ms 流式合并刷新，同时接入上游的新会话结束、编辑器粘贴等事件依赖。
- `rpc-manager.ts`：同时保留上游 `projectTrusted` 设置边界、llama.cpp 内置 provider，以及本地提示词快照和资源覆盖。没有以一侧覆盖另一侧来消除冲突。
- 提示词和委派插件的开发依赖、锁文件对齐 SDK 1.5.2；插件核心逻辑不改动。
- `bootstrap` 显式安装开发依赖，避免从生产 Web 进程继承 `NODE_ENV=production` 后跳过锁定的 TypeScript，误用系统编译器。
- 新增真实 SDK 测试：新会话在等待启动确认框时仍可被页面访问；项目未受信任时不采用项目设置；模板修改和默认项切换后恢复会话，仍使用原提示词；同时保留上游内置 provider。
- 浏览器测试支持指定本机 Chrome；流式指标测试与组件使用同一个 i18n 导入别名，避免 Windows 下 jiti 产生两份 React context。没有修改应用中的语言上下文保护。

## 验证

在隔离工作树中使用 Node.js 24 和本地构建的 Pi 1.5.2：

- `npm run bootstrap`、`npm run build:pi`：通过。
- Pi 子树 `npm run check`：通过，检查 2545 个文件，无自动修复；包含类型、依赖、安装锁和浏览器入口检查。
- 根目录 `npm test`：提示词 10 项、委派 22 项、Web 本地回归 67 项通过；两套委派 SDK/会话亲和性集成验证通过，仅请求本地模拟服务。
- `npm run test:tooling`：9 项通过。
- `npm run check:web`、Web `npm run lint`：通过。
- `npm run build:web`：通过；导出路由仍有上游动态依赖表达式的编译警告。
- 生产模式 `npm run test:e2e`：桌面、手机宽度、会话分页/分支、扩展对话框、编辑器焦点、多标签页、目录选择等检查通过。
- 额外生产页面检查：系统 tab 能创建并启用模板，期间不创建新会话；流式 240 个片段合并为 48 次 DOM 更新，321 行完整保留，暂停后的尾随滚动、上翻阅读位置和完成事件通过。该合成场景主线程任务约 1.41 秒，不代表所有页面的性能。
- 公开内容审计及精确私密值检查：通过。`npm audit --omit=dev` 无漏洞；包含开发依赖的安装审计仍报告 12 个低/中风险项，没有擅自运行 `audit fix` 改变上游锁文件。

**全量 Web 单元/集成套件未全绿**：3552 项中 3447 通过、39 跳过、66 失败。失败包括这台 Windows 的符号链接权限、Unix 路径假设、CRLF 源码匹配等；此前 0.15.0 全量套件也有 63 项失败。新增 CLI 状态用例单独复跑通过。上述结果不等同于全量测试通过，日志保留在本机隔离验证目录中。

## 运行环境注意事项

本次同步不修改现有凭证、模型网关、会话、提示词目录，也不自动部署或重启运行服务。源码合并与切换运行版本是两个步骤。

SDK 1.5.1 起，`cacheWarming` 默认从 `streaming` 改为 `idle`，符合条件时可在两轮之间继续预热缓存；切换运行版前应评估是否显式保留旧设置。Anthropic 消息线程默认只对官方 provider/地址启用，网关需要自身支持；OpenAI-compatible 在没有活动工具时默认省略 `tools`，特殊旧代理可通过上游兼容选项恢复。同步没有替用户修改这些运行时选项。
