# 输出 Token 上限修复

## 证据

`~/.dsh-delivery/model-logs.sqlite` 的实际调用记录显示，同一交付发生两次独立触顶：

- 单 HTML 子 Worker：DeepSeek，inputTokens=12215，outputTokens=16384，finishReason=max-tokens；交付 `e30620dc-0b97-48cb-8a3d-3975ae853cd4` 随即以 `WORKER_MAX_TOKENS` 失败。
- 根会话收到失败后继续生成：DeepSeek，inputTokens=13245，outputTokens=32768，finishReason=max-tokens。

因此 UI 提示不是旧消息，也不是上下文输入超过限制。第一处是子 Worker 输出预算，第二处是失败后的根模型继续尝试生成大内容。

## 修复

- `agent.cordis.yml` 将 singleHtmlWorker 从 low/16384 改为 off/32768。
- `delivery_start` 对 WORKER_MAX_TOKENS 返回精简终态，不再把长 objective 与 Task IR 重复送回根模型。
- Runtime 在同一用户 turn 内隐藏根级 write/edit/delivery_start，并在实际执行层再次拒绝，避免绕过失败门禁重新生成整份文件。
- 新用户消息清除本轮锁；用户可以缩小目标后发起新交付。

未提高模型声明的 32768 最大能力，也未把截断当作可恢复重试。若完整文件本身仍超过单次模型能力，应由根模型在新的用户 turn 中缩小产物或拆分可组合的工作，而不是重复相同调用。
