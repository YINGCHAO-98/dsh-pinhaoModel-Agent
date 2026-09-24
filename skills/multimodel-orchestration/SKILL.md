---
name: multimodel-orchestration
description: DeepSeek 负责需求理解、拆分、路由、调度、整合和失败重规划；产品设计交 MiniMax，编程交 GLM-5.3，独立研发与网页验收交 Kimi K2.8。
---

# 多模型编排

以更好的专业匹配、独立视角和交付速度为目标，同时控制不必要的调用。
当任务覆盖产品定义、方案设计、代码实现和功能测试的完整生命周期时，另外加载 `software-delivery-harness`，
使用 delivery_start 自动执行 MiniMax 产品设计、GLM-5.3 实现与本地检查；已验证交付由 Kimi K2.8 独立验收，网页还要完成截图验收。专业分析节点通过 multimodel_run 编排，不使用历史 workflow 脚本。

## 规划

1. 明确最终交付物、约束和验收条件。
2. 主动识别研究、视觉、创意、动画设计、代码实现和独立复核等能力域；专业模型能明显改善结果时直接委派，不等待用户指定模型。
3. 两个或以上能力域可以独立产出或并行推进时，拆为多模型 DAG；存在依赖时明确交接顺序。
4. 文件交付统一先产品设计再实现；小任务缩短方案内容，不额外堆叠规划调用。GLM 只分析静态视觉，豆包只负责动态媒体理解；创意、架构和实施方案归 MiniMax。
5. 用 dependsOn 标明各节点所需的上游结果。

## 能力选择

能力边界与必需交付以 `request_capability` 的实际工具 schema 和控制器注册表为准；模型映射由 preset 配置管理，本 Skill 不维护第二份模型路由表。

简单且单一领域的 bug 可直接 `delivery_start`。专业模型能提供更匹配的能力、独立视角或并行提速时主动申请协助，并写明目标、协作价值、输入引用、预期产物和验收条件。代码实现 Worker 也可以在执行中申请；专业节点与审查节点不能继续委派。

不要把“有多个步骤”当成需要多个模型的依据。能力尚未接入时直接说明不可用，不以另一种能力冒充。

## 交接与验收

每个委派包含目标、必要上下文、输入绝对路径、输出要求、约束和验收标准。子 Agent 返回：

- 状态
- 核心结果
- 产物绝对路径
- 验证证据
- 限制和未解决问题

长内容完整写入结构化 summary，由控制器保存报告，下游接收依赖报告。根 Agent 在最终交付前核对全部验收条件，不把子 Agent 的自评直接当作验收结论。

鉴权、权限、模型未开通或参数不支持错误不盲目重试；恢复以控制器实际状态和预算为准。失败后由 DeepSeek 重新规划，但不得切换实现模型或代替 Worker 写代码。

## 当前执行接口

专业请求优先用 `request_capability`，按工具 schema 提交 `capability`、`objective`、`reason`、`singleModelGap`、`inputRefs`、`expectedOutput`、`acceptanceCriteria`。原 `task_*` 是同一受控入口的兼容名称，除了隐含 capability 外需要相同字段。

`inputRefs` 使用 `file:相对路径` 或已验收的 `report:任务ID`。跨能力并行任务用 `multimodel_run`；各节点提交相同的理由与产物约定，再加 `id`、`tool`、`dependsOn`。依赖报告自动传递。通过 `delivery_start.reportRefs` 把返回的 `artifactRef` 交给研发；不手工复制、截断报告。

`capability_status` 查看实际合同、调用进度与验收事件。模型提交的 passed 不等于控制器接受；报告结构、真实工具证据与内容质量判断分开记录。不得把路由注册、模型自评或口头计划当作已交付。
