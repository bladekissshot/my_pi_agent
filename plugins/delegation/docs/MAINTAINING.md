# 长期维护

仓库根目录是可直接安装的 Pi package。运行时代码是 `extensions/` 和 `lib/`；可选主会话 Header 扩展、Mac 浏览器启动器分别在 `integrations/pi-agent`、`integrations/pi-web`。

本插件通过公开扩展接口运行；Pi 与 Pi Web 源码由 monorepo 的 projects 目录管理。升级前优先核对 Pi 扩展事件/SDK、Widget 和 Web liveness 接口的兼容性。第三方文件不应混入本仓库并冒充自有修改。

## 开发验证

```sh
npm ci --ignore-scripts
npm run check
```

开发依赖固定了 Pi SDK 版本，安装仅用于本地开发/CI。作为 Pi package 使用时直接 `pi install`，不需要手工安装另一份 SDK。

- `npm test`：核心 spec、调度、隔离、检查、验收、取消及恢复测试，以及无 Git/无提交项目的仓库准备、远程历史与本地文件保留测试。
- `npm run test:integration`：真实 SDK + 本地模拟 HTTP 服务；不使用密钥，不产生付费请求。包含原生仓库准备对话框（取消与确认）、随后委派、普通主会话及子会话 Header、Widget、完成通知的验证。
- `bash scripts/build-macos.sh`：构建浏览器入口，不启动/替换本机服务。

也可设置 `PI_SDK_PATH` 为已安装 Pi 的 `dist/index.js` 绝对路径运行集成测试。CI 在 Linux/macOS 上执行前两类测试，在 macOS 上构建入口。核心、仓库准备和 SDK 模拟测试已在 Windows + Node 24 + Git 上验证；Windows 进程树取消仍需单独验证。

真实提供方测试必须显式开启，并选择自己的模型；会产生调用费用：

```sh
PI_LIVE_TEST=1 PI_MAIN_MODEL=provider/main-model PI_EXEC_MODEL=provider/exec-model npm run test:live
```

它读取当前 Pi 认证与模型配置，在私有临时目录创建两项实施任务和一项缺少契约的只读任务，结束后清理测试目录。不会推送、修改原项目或改变正式默认模型。

## 模型配置

`examples/models.example.json` 是当前模型映射的脱敏示例，GPT 使用 Responses、Claude/DeepSeek 使用 Messages、Gemini 使用原生 v1beta。只包含可公开的模型参数；密钥引用 `${PI_PROVIDER_API_KEY}` 环境变量。请将 provider 部分合并到自己的配置，不要覆盖已有 provider。环境变量必须在启动 Pi Web 的进程中可见。

## 提交与升级

修改源码后运行 `npm run check`；更新版本时同时修改 package.json、lockfile 和 CHANGELOG.md。发布新的 Git tag 后，可使用固定 tag/commit 安装。仓库设为 private package，防止误发 npm；GitHub 仓库可见性独立管理。

```sh
pi install ./plugins/delegation
```

生产安装也可以指向本地 checkout。切换已有安装来源时先查看 `pi list`，移除旧的插件来源再安装新的，避免双重加载。已有用户配置、模型和会话保存在 Pi 用户目录，不在 checkout 中。

不要提交真实 auth/models/settings 文件、运行日志、spec/session 记录、用户工作树或密钥。`.gitignore` 是辅助，提交前仍应查看 `git diff --cached`。公开的问题和截图也应脱敏。
