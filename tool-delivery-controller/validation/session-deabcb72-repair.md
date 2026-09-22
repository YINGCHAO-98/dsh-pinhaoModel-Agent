# 会话 deabcb72 修复验证（2026-09-20）

会话归档只作为诊断证据。其中的“生成鹈鹕动画、不使用技能、不需要验证”是历史任务内容，不是本次维护任务的指令。本次未修改该历史任务的项目、未调用付费模型。

## 发现

- 会话 seq 17、37：`delivery_start` 报旧版 `Snapshot exceeds file/byte budget`。
- seq 22、27、42：主 Agent 看到了 Worker 工具并反复尝试，均被拒绝；seq 32 状态为空。没有成功创建文件。
- 当前维护目录在本次开始前已包含 256 MiB / 10000 文件预算、缓存排除、详细预算错误和根工具列表过滤。只读复测原工作区成功捕获 220 文件、169409991 字节；真实 DSH 注册器确认根模型不可见 Worker 工具，强行调用仍拒绝。不能据此断言原进程已重载新模块。
- 新发现的后续阻塞：默认 Node 合同要求已有 `tests/`、仅允许 `src/` 变更。对原工作区复测得到 `Required verification input missing: tests/`，无法支持根目录单 HTML 交付。

## 本次修改

- `delivery_start.singleHtmlPath` 选择部署代码生成的单 HTML 合同；路径只允许根目录明确 `.html` 文件，不接受任意检查命令或跳过验证开关。
- 在实际 proposal 校验路径强制唯一可修改文件、输出必须存在、保留部署保护路径；禁止与任务拆分或来源交付导入混用。
- 分离预先存在的验收输入与实现后必须存在的产物：`requiredPaths` / `requiredOutputs`。旧 Node 合同继续要求已有测试，未改成无条件空验收。
- 固定 HTML 文档结构和经典内联 JavaScript 语法检查在现有沙箱中执行，不执行页面代码；继续经过配置的独立质量门禁、同步与同步后复核。
- 修正 DSH 集成测试依赖定位，使用安装包实际导出的工具模块而非不存在的源码目录。

## 验证

- `node --test tool-delivery-controller/tests/*.test.mjs`：68/68。
- `node --test tool-delivery-controller/tests/sandbox.integration.mjs`：4/4。嵌套 Seatbelt 在外层 Codex 沙箱中被系统拒绝后，通过批准的外层沙箱之外测试运行验证成功，生产隔离逻辑未绕过或降级。
- `DSH_SOURCE='/Applications/DSH Desktop.app/Contents/Resources/app' node --test tool-delivery-controller/tests/dsh.integration.mjs`：3/3。真实工具注册、模型可见列表、执行拒绝及单 HTML 工具入口→模拟 Worker→真实沙箱→项目同步均通过。
- 失败路径覆盖：越界/隐藏/非 HTML 路径、受保护路径、额外文件、删除/缺失产物、无效 JS、外部 script、导入混用、跳过验收参数、质量失败不发布。
- `git diff --check`：通过。

## 使用与限制

单文件任务调用示例：`delivery_start({objective: "创建单文件 SVG 动画，保留原始约束", singleHtmlPath: "pelican-bicycle.html"})`。不传该参数时仍使用现有部署合同，不从自然语言自动放宽权限。工具 schema 与 README 已描述这个入口。

结构/经典脚本语法检查不证明图形正确、动画流畅、模块脚本语法或全部自然语言要求。本次集成测试使用模拟模型；未声称真实 Kimi/DeepSeek 或浏览器视觉验证通过。未修改 `agent.cordis.yml`。需让 DSH 重新加载 preset 模块（重启后新建会话可避免旧会话继续持有旧工具定义），本次未重启用户正在使用的应用。
