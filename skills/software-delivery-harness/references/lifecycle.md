# 固定生命周期

`implement → implementing → verify → verifying → passed`

验证失败时：`verifying → repair → repairing → verify`，最多两轮修复。修复计数在启动修复模型前持久化。

环境或基础设施问题进入 `blocked`，用户 `/deliver resume <id>` 恢复；计数不重置。重启发现 implementing/repairing/verifying 时，记录 interrupted 并恢复对应阶段。模型仅生成无副作用变更提议，因此中断阶段可以重新请求，另有持久化的总调用预算防止无限恢复。

验收结果绑定当前快照，已通过的导出产物被修改后，在查询状态时标记 invalidated。通过产物在独立目录交付，不覆盖原项目。命令/检查失败不会伪造完成。

这里的文档不执行门禁；状态机由 [controller.mjs](../../../tool-delivery-controller/controller.mjs) 与 [store.mjs](../../../tool-delivery-controller/store.mjs) 实现。
