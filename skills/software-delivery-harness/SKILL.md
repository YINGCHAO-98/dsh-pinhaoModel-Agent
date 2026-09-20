---
name: software-delivery-harness
description: 解释拼好模固定交付控制器的入口、验收合同、状态与证据。不生成动态 workflow 脚本，也不承担运行时门禁。
---

# 固定软件交付流程

当前 preset 的控制机制位于 `../../tool-delivery-controller/`。本 Skill 只是说明，不是流程执行器，当前精简 preset 不自动加载 Skill 工具。

收到明确的自然语言执行需求时，模型主动调用 `delivery_start`，由控制器运行实现、验证和有界修复。用户也可使用 `/deliver start <目标>` 手动启动同一闭环。
实现和修复模型只能返回结构化文件变更；控制器应用变更、冻结快照、启动验证、消费修复预算并决定结果。

- `passed`：合同中的所有检查在同一快照上通过；不等价于所有自然语言需求已被证明。
- `failed`：最多两轮修复后仍未通过。
- `blocked`：环境、权限、输出格式或执行预算阻塞；保留证据，不当作通过。
- `cancelled`：用户取消，不自动继续。
- `invalidated`：已导出的验证产物被修改或丢失。

不得再用旧 `workflow` 模板、自报 `status: passed` 或 todo 完成状态代替控制器结果。
部署、项目验收合同及限制见 [运行时说明](../../tool-delivery-controller/README.md)。
