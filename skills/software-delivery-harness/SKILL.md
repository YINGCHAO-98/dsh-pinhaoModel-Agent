---
name: software-delivery-harness
description: 解释拼好模固定交付控制器的入口、验收合同、状态与证据。不生成动态 workflow 脚本，也不承担运行时门禁。
---

# 固定软件交付流程

当前 preset 的控制机制位于 `../../tool-delivery-controller/`。本 Skill 按需加载，只是说明，不是流程执行器。

凡涉及代码或文件实现都调用 `delivery_start`。控制器自动执行 MiniMax M3 产品设计，再由 GLM-5.3 Worker 实现与修复，沿用隔离工作区和原验收合同。根模型只读取、编排和整合，不直接 write/edit。不在 delivery_start 前重复申请同一产品方案。方案绑定输入快照，保存目标、用户、功能范围、用户流程、实施思路、验收条件、风险和假设。小修复给简短方案；设计失败不会进入实现，恢复最多补充一次设计尝试。子任务、实现重试和修复复用原方案。

所有已验证交付在同步前必须通过 Kimi K2.8 独立代码与功能验收；网页任务还须通过真实浏览器截图验收。风险判断是模型评估，不等于形式证明。用户也可使用 `/deliver start <目标>` 手动启动同一闭环。用户明确禁用验证时，把该约束保留在 objective 中；控制器只允许独立 project 单 HTML 进入 `assurance=unverified`，保留产品设计和受控同步，但跳过检查与修复。禁用 Skill 与禁用验证是两个独立选择。
将任务必要目标、接口、依赖和验收要求传入 objective，交付状态以 delivery_status 的结果为准。

需要总 agent 编排多个实现任务时，用 delivery_start.tasks 登记每项的目标、必要上下文、接口、验收条件、editablePaths 和 dependsOn；控制器固定任务归属并执行依赖，全部通过后再整体集成。checkIds 仅能选择部署合同中已有的检查，不能提交或修改检查命令。简单任务省略 tasks。

独立分步交付指定 mode=partial，在独立副本验收并导出。总 agent 用 mode=project（默认）和 sourceDeliveryIds 汇总同会话已通过的分步产物，控制器重新集成验收，自动同步当前项目并复核，无需例行确认。

兼容的并行修改自动合并；仅对需要用户取舍的 conflicts 提问。控制器直接向宿主用户交互服务提问并核验回答，工具不接受模型提供的冲突选择。已有任务可通过 delivery_resume 再次触发处理，不能自行替用户作行为取舍。普通测试失败由控制器继续有界修复。

project 的 syncReceipt 记录已经同步的版本；projectMatchesReceipt 表示查询时是否仍匹配。外部工具未接入时如实报告，不把文件同步当成工具操作成功。

- `passed`：默认 `assurance=verified` 时，partial 表示配置的本地检查通过，project 还必须完成同步与复核。required 策略下所有已验证交付还须通过 Kimi K2.8 独立验收；网页还须通过真实截图验收。只有用户任务合同中的验收条件进入状态清单；产品方案的建议不会自动升级为强制检查。尚未自动验证的语义要求不能因文件同步而声称全部通过。`assurance=unverified` 时只表示单 HTML 已生成并受控同步，`syncReceipt.verified=false`，不得说成验收通过。
- `failed`：交付未通过，向用户说明返回的失败原因。
- `blocked`：环境、权限、输出格式或执行预算或待决定的集成冲突阻塞；保留证据，不当作通过。
- `cancelled`：用户取消，不自动继续。
- `invalidated`：已导出的验证产物被修改或丢失。

不得再用旧 `workflow` 模板、自报 `status: passed` 或 todo 完成状态代替控制器结果。
部署和硬约束由维护者在控制器代码与验收合同中管理。
