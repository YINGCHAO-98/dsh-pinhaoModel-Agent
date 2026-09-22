---
name: multimodel-orchestration
description: 为需要多模型协作的复杂任务设计可执行 DAG，并行调度独立节点并验收结果。不用于可由单一 Agent 直接完成的原子任务。
---

# 多模型编排

以最短可靠关键路径为目标，而不是追求 Agent 数量。
当任务覆盖产品定义、方案设计、代码实现和功能测试的完整生命周期时，另外加载 `software-delivery-harness`，
使用 delivery_start 执行研发交付与独立 Kimi 质量门禁。专业分析节点通过 multimodel_run 编排，不使用历史 workflow 脚本。

## 规划

1. 明确最终交付物、约束和验收条件。
2. 先判断主能力域。普通问答和简单操作由 DeepSeek 直接完成；单一能力任务最多委派一个专业模型。
3. 只有最终交付跨越两个或以上能力域，且每个节点都能产生不可替代的独立结果时，才拆为多模型 DAG。
4. 多步骤、多文件、自测、错误重试、单张图片、单篇文档或单个网页都不自动构成多模型任务。
5. 用 dependsOn 标明各节点所需的上游结果。

## 能力选择

能力边界与必需交付以 `request_capability` 的实际工具 schema 和控制器注册表为准；模型映射由 preset 配置管理，本 Skill 不维护第二份模型路由表。

简单 bug 直接 `delivery_start`，无需额外规划 Agent。确有能力缺口才申请协助，并写明目标、原因、单模型缺口、输入引用、预期产物和验收条件。代码实现 Worker 也可以在执行中申请；专业节点与审查节点不能继续委派。

不要把“有多个步骤”当成需要多个模型的依据。能力尚未接入时直接说明不可用，不以另一种能力冒充。

## 交接与验收

每个委派包含目标、必要上下文、输入绝对路径、输出要求、约束和验收标准。子 Agent 返回：

- 状态
- 核心结果
- 产物绝对路径
- 验证证据
- 限制和未解决问题

长内容完整写入结构化 summary，由控制器保存报告，下游接收依赖报告。根 Agent 在最终交付前核对全部验收条件，不把子 Agent 的自评直接当作验收结论。

鉴权、权限、模型未开通或参数不支持错误不重试；临时网络、限流或超时最多重试一次，随后按根 Persona 的回退策略继续可行交付。

## 当前执行接口

专业请求优先用 `request_capability`，按工具 schema 提交 `capability`、`objective`、`reason`、`singleModelGap`、`inputRefs`、`expectedOutput`、`acceptanceCriteria`。原 `task_*` 是同一受控入口的兼容名称，除了隐含 capability 外需要相同字段。

`inputRefs` 使用 `file:相对路径` 或已验收的 `report:任务ID`。跨能力并行任务用 `multimodel_run`；各节点提交相同的理由与产物约定，再加 `id`、`tool`、`dependsOn`。依赖报告自动传递。通过 `delivery_start.reportRefs` 把返回的 `artifactRef` 交给研发；不手工复制、截断报告。

`capability_status` 查看实际合同、调用进度与验收事件。模型提交的 passed 不等于控制器接受；报告结构、真实工具证据与内容质量判断分开记录。不得把路由注册、模型自评或口头计划当作已交付。
