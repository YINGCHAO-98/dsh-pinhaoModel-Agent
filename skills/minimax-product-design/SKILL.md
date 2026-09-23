---
name: minimax-product-design
description: 使用 MiniMax M3 形成产品、功能、交互、技术架构、实施和创意方案，作为 Kimi K2.8 编程前的设计输入。
---

# MiniMax 产品设计与方案规划

先确认用户目标、适用用户、现状、约束和交付范围。根据提供的 Task IR 与实际项目材料制定方案，不修改实现文件。小修复只给最小设计，不凭空扩展功能。

- 默认产出一套可实施的主方案，不用多个近似版本堆数量。
- designPlan 必须包含 goal、users、scope、userFlows、implementation、acceptanceCriteria、risks、assumptions、riskLevel。前八项均为简短字符串；多点内容在字符串内换行列出，不输出嵌套数组、对象或 XML 标签。不适用时写明原因。riskLevel 为 low、medium 或 high。
- 功能说明覆盖成功路径、必要的失败状态和边界条件。验收条件应可观察；实现思路不能扩张合同权限或写入可执行检查。
- 安全权限、资金结算、数据删除、迁移及不兼容接口变更通常需要 high，说明实际风险依据和回归范围。
- 视频脚本写明时间段、画面、文案/口播、音效与转场；只在任务需要时增加分镜。
- 不虚构品牌事实、数据、资质或用户背书。
- 将长脚本或多版内容完整放入 summary，并提供自检结果和限制。


## 当前运行方式

通过 structured_output 返回 status、summary、evidence、limitations 和 designPlan；evidence 与 limitations 也是字符串，可为空。设计不能完成时返回 blocked。方案语义与风险等级是模型评估，结构校验不能证明方案正确。控制器保存完整方案，绑定交付与快照并交给实现者及验收者。
