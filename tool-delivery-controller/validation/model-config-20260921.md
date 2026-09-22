# 模型配置调整验收

已调整实际加载的 agent.cordis.yml、host/settings.yaml 参考配置及 DSH harness/settings.yaml。

发现：doubao 自定义 DeepSeek 模型缺少 reasoningEfforts 和 compat.thinkingFormat。安装的适配器对无能力声明的模型不发送思考控制字段；因此不能将界面 Default 当成低思考或关闭思考。该配置缺口已确认，但没有足够证据认定所有历史延迟均由它造成。

调整：补齐 off/low/high/max 能力与 deepseek 参数格式、supportsReasoningEffort；默认模型选择 low；模型默认输出上限和交付 Worker 显式 maxTokens 均为 32768。Worker 的 reasoningEffort/maxTokens 已接入实际 subagent agentOptions，并增加参数拒绝校验。精简 persona，明确单 HTML 路径、任务进度、取消和恢复说明。未放宽执行隔离与验收合同，未修改其他专业模型参数。

验证：76 项单元测试、5 项 DSH 集成测试、1 项安装版本参数序列化测试通过，合计 82 项。序列化测试在网络请求前截获参数，确认 low 发送 thinking enabled + reasoning_effort low，off 发送 thinking disabled，输出上限实际发送。git diff --check 通过。

在线最小请求：使用 DSH 原生适配器和原生凭据服务，low、maxTokens 512、30 秒超时，仅发送“只回复 OK”。2169ms 返回 OK，finish.kind=stop。探针随后因错误调用 ctx.dispose 发生本地清理异常；请求成功结果仍有效，探针已改为 ctx.fiber.dispose，未为清理异常追加模型调用。这只验证接口兼容，不代表完整交付性能已验证。

运行加载：Harness 已通过 Desktop 菜单重启；原会话默认选择不会自动随新会话默认值更新，已通过界面将该会话明确选择 Low，并核验界面显示 deepseek-v4-1-flash · Low。没有重新执行历史动画任务。

实际宿主配置变更前备份：/tmp/pinhaomo-settings-before-20260921-110830.yaml。
