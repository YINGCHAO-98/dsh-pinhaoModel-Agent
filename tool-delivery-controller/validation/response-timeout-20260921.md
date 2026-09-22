# 2026-09-21 模型写入后长时间无响应

## 实际证据

参考共享对话 `https://chatgpt.com/share/6ab0c74e-9fdc-83e8-9977-d9fba4455895` 显示“思考了 5m 10s”，产出单 HTML 鹈鹕骑车 SVG 动画。该显示时间不等同于严格可比的端到端基准。

Desktop 会话 `session-5953c682-3064-4739-9d92-1b7c2fecd9f9`：
- 第一模型请求 107961ms，首响应约 3706ms；write 工具 242ms。
- seq 18 明确记录 write 成功，实际 pelican-bicycle.html 为 17192 字节、387 行。
- 第二模型请求出现四次 `pi-ai stream idle timeout after 300000ms`，TIMEOUT 被默认 maxRetries=5 的策略重试；第五次尝试中用户停止。
- 全轮 26分19秒，其中文件早已写入。没有证据证明是文件工具死锁。
- 上游为什么不返回仍未知，不能把缩短超时表述为修复上游模型或保证视觉质量。

## 修改

维护副本 `host/settings.yaml` 与 Desktop 实际 `harness/settings.yaml` 的 doubao provider 同步设置：
- streamIdleTimeoutMs: 120000（连续无输出上限，不是总生成时长）。
- retryPolicy: normal，maxRetries: 1。
- retryableCodes: EMPTY_RESPONSE、RATE_LIMIT、SERVER、TRANSPORT；TIMEOUT 不再自动重试。

实际配置备份：`harness/settings.yaml.before-response-timeout-20260921`。保留模型、低推理等级、32768 输出预算及所有工具/沙箱/质量门禁。未修改 agent.cordis.yml。

这属于 provider 级参数，会影响 Desktop 中共享 doubao 路由的其他预设。连续两分钟完全无输出的慢请求会提前报错。恢复旧策略可使用备份中的这两个参数，不应覆盖后续无关设置。

确认原会话空闲后，通过 Desktop Harness 菜单重启后端，桌面恢复并能预览已生成的 HTML。

## 验证

`node --test tool-delivery-controller/tests/model-config.integration.mjs tool-delivery-controller/tests/response-timeout.integration.mjs`：3/3 通过。

包括安装版适配器真实 watchdog 的中止路径（30ms 缩时 fixture）、正式配置的超时不重试策略解析、原模型请求参数回归。无外部请求的 fixture 不冒充在线模型验证。

独立在线 smoke：使用实际配置和安装版适配器，仅发送虚构的简短工具调用/工具结果历史，无用户文件、无实际文件写入；同一模型 3565ms 首块、3772ms 正常结束，回复确认虚构文件已创建。报告在 response-smoke-20260921.json。这是合成历史的链路验证，不是原会话恢复，也不是视觉质量验收。

未重跑原动画任务，未改变其产物，未声称已达到参考作品质量或所有请求均稳定。
