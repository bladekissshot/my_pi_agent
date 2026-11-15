# 执行任务 spec 示例

启用 `/delegation auto` 后，主模型可向 `delegate_task` 提交以下参数。若项目没有 Git 或首次提交，开启时会引导用户提供仓库地址并确认本地基线；也可提前运行 `/delegation repo`。先检查实际文件和测试命令，再调整这份示例。

```json
{
  "title": "实现整数加倍函数",
  "goal": "让 double(n) 对零、正整数及负整数返回两倍的数值。",
  "context": "double.mjs 已导出 double(n)，目前会抛出未实现异常。tests/double.test.mjs 已包含固定用例。工程使用 Node 内置测试，无外部依赖。",
  "kind": "implementation",
  "requirements": ["保持 export function double(n) 的接口", "double(0) 为 0，double(3) 为 6，double(-2) 为 -4"],
  "constraints": ["不得修改测试或其他模块", "不安装依赖，不扩大类型约定"],
  "allowedPaths": ["double.mjs"],
  "acceptance": [{
    "description": "现有 double 测试全部通过",
    "command": "node --test tests/double.test.mjs",
    "expected": "退出码为 0，固定用例全部通过"
  }],
  "dependencies": []
}
```

插件验证后进入待验收。主模型读取 `delegate_status` 中的工作树和检查输出，审查 diff，集成并测试后，以具体证据调用 `delegate_review`。依赖后继任务需要先把前置成果集成并提交到父仓库，再验收放行。

只读调查使用同一执行模型，将 kind 设为 analysis，并明确唯一事实来源和缺少信息时的阻塞条件；可以只有人工验收标准。
