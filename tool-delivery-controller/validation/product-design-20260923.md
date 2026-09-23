# 2026-09-23 产品设计阶段与角色分工

当前 preset：DeepSeek V4.1 Flash 总编排；MiniMax M3 产品设计；Kimi K2.8 Preview 唯一实现；Kimi K2.7 Code 独立验收；GLM 5.3 Flash 静态视觉；豆包 Seed 2.0 Lite 动态媒体理解（当前输入适配仅支持字幕和帧图）。

## 实际机制

- preset 作用域的根请求钩子选择 DeepSeek，子请求不被改写。
- 实现入口仅接受 kimi-k2-8-preview；拒绝 HTML 专用路线和 Worker 回退路线。根 write/edit 在模型工具过滤、执行 guard 和文件调用入口均拒绝。
- design/designing 是持久化状态。MiniMax 必须返回结构化 designPlan，方案绑定任务目标、owner、输入快照和模型。方案成功才可实现；失败显式恢复最多再尝试一次，取消与重启保留预算。
- 实现、修复、验收收到同一产品设计；子任务继承父方案。能力报告哈希和归属在交接时重新检查，篡改或缺失会阻塞。
- risk_based 策略对 high 方案启用 Kimi K2.7 同步前验收；其他任务可用 delivery_review 额外审查。用户明确取消验证的受限 HTML 保留设计，记录未验证交付。
- 产品方案的文本验收标准进入状态输出，不因写文件或模型自述成功而自动通过。
- 专家模型身份与只读权限受路由校验；方案专家没有 Shell/写权限。Seedream/Seedance 和原生音视频输入显式标记不可用，未伪装为文本工具。

## 验证

- `node --test --test-reporter=dot tests/*.test.mjs`：151 项通过。
- `DSH_SOURCE=/Users/chowchow/Desktop/codeing/deepseek/deepseek-harness node --test tests/dsh.integration.mjs`：10 项通过；真实 DSH 工具注册器、Seatbelt 子沙箱与临时文件同步，模型回复为 fixture。外层沙箱拒绝嵌套 Seatbelt 后，经批准在外层沙箱之外运行通过。
- 使用安装包 YAML 解析器读取实际 agent.cordis.yml，通过角色校验：4 个只读专业路由、MiniMax 设计、Kimi K2.8 实现、risk_based 验收。
- 覆盖方案失败/结构缺失/错误模型/错误快照、任务身份与方案不可变、设计阶段恢复和取消、修复与子任务继承、报告完整性失效、高风险验收失败不发布、原生音视频未接入拒绝等路径。

## 限制

未进行付费线上模型生成，也未重启用户正在运行的 DSH 会话。新配置需重新加载 preset。方案内容、风险识别和语义验收仍依赖模型判断，结构门禁不是语义正确性证明。ArkCLI 认证状态查询在专属状态目录迁移阶段被本机写权限阻止，未验证生成模型版本、未修改旧凭据；生成适配器仍未接入。
