# 统一会话 Header 扩展

通过 Pi 官方 `before_provider_headers` 事件为所有普通会话请求设置 `x-session-affinity = 当前 Pi session ID`。同一会话切换模型保持 ID，新会话使用新 ID。保留旧 company provider 的 `x-session-id` 兼容行为。

这个可选扩展供主会话使用；委派插件的执行会话已有同等 Header 逻辑。Pi CLI 与 Pi Web 都可以加载。

从本仓库安装：

```sh
pi install ./integrations/pi-agent
```

或者将 `session-affinity.ts` 放到 `~/.pi/agent/extensions/`。如果已有旧文件 `company-session-headers.ts`，用本文件更新它，不要重复安装两份。

本目录不包含密钥。模型和凭据由现有 Pi 配置管理。绕过扩展系统、直接调用 SDK 的程序不会自动获得此 Header。
