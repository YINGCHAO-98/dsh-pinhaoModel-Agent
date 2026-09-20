# 运行时合同

旧的模型生成 `workflow` 示例已撤下。现在合同来自部署维护者配置的 `delivery-contract.json`，每次任务开始时固定保存到数据库。

模型输出只有 `summary` 和 `changes`：每项包含项目内相对路径 `path`、`operation`（write/delete）和文件完整文本 `content`。模型不能提交命令、状态变更、预算或新的验收规则。

控制器检查可修改路径、保护路径、路径穿越、重复路径、文件预算和必要验收输入，然后存储内容寻址快照。验证 Runner 在隔离环境里执行合同 argv，记录实际退出码和输出。默认 Node TAP 合同还要求至少一个测试通过，避免零测试通过。

模型使用 `delivery_start` 创建并执行任务，使用 `delivery_status` 查询状态；`/deliver` 保留手动创建、恢复、取消入口。完整接口见 [README](../../../tool-delivery-controller/README.md)。
