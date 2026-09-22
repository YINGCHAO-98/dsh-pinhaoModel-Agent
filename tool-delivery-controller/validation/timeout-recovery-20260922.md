# 实现超时恢复（2026-09-22）

交付 3c67b1c0-9517-46bc-8156-65cfae17ab34 于 07:02:14Z 开始实现，07:04:14Z 被单 HTML 本地 120 秒截止取消。Kimi 请求记录 cancelled、119966ms、tools=[]；不能据此判断模型没有在生成。verifyCalls=0、syncAttempts=0。

修复：移除 dshWorker 额外的 singleHtmlFirstWriteTimeoutMs 定时器，仅使用控制器执行信号；实现总预算 600000ms，供应商 idle timeout 独立保留。总截止说明明确为未完成工具调用，不再推断模型未生成。

控制器对确认 executionCount=0 的本地执行超时或供应商 TIMEOUT 自动恢复一次，沿用交付 ID、快照、动画报告和质量门禁。重试次数持久化，重派前旧适配器必须完成子模型与副本清理，重试输入要求简洁完整实现。已有工具调用、调用方取消、输出超限、限流不走此路径。重试耗尽标记 WORKER_TIMEOUT_RETRIES_EXHAUSTED，不允许通过根工具同轮重新创建来重置预算。未修改旧失败记录或生产业务文件。

验证：121 项单元/控制器回归通过；9 项 DSH 集成测试通过（模拟模型、真实沙箱和临时文件）。覆盖原交付内重试成功并同步、连续超时最多两次 dispatch、取消不重试、工具操作后不重试、HTML 使用控制器原始 signal、DOMException 超时分类与旧实例清理。

已确认 Desktop 当前会话空闲，通过 Harness 菜单重启，UI 已恢复原会话。未重跑真实 Kimi 动画生成，不能保证模型供应商响应或声称 HTML 已产出。
