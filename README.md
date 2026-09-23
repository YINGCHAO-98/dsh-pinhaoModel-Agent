# 拼好模 1.0 · DSH Agent

本仓库直接维护 DSH Desktop 实际加载的拼好模 preset。

本机目录：`~/Library/Application Support/dsh-desktop/harness/.agent-presets/pin-hao-mo/`

远端：https://github.com/YINGCHAO-98/dsh-pinhaoModel-Agent

## 日常维护

直接在本目录编辑，在 GitHub Desktop 中查看差异、提交并推送。旧工作区副本不再作为运行配置来源。Git 提交不会自动让现有 DSH 会话重载配置。

- `agent.cordis.yml`：当前插件入口、persona 与模型配置。
- `tool-delivery-controller/`：专业模型调度、实现、按需独立审查、有界修复和持久化审计控制器；说明见该目录 README。
- `delivery-contract.json`：验收命令、受保护路径及修复预算。
- `skills/`：通过 Skill 工具按需加载的角色技能；只加载本 preset 的技能目录。
- `_retired-skills/`、`agent.prompt-based.yml`：历史资料。
- `host/`：保留自之前提交的宿主配置参考快照，不是本机当前宿主配置的实时镜像。
- `snapshot.sha256`：旧版提交的历史校验清单，不用于校验当前控制器版。

明确的自然语言执行需求由模型调用 `delivery_start` 启动交付，也可手动使用 `/deliver start <目标>`。模型可调用 `delivery_status` 查询状态，交付判定由控制器和配置检查决定。运行数据位于 `~/.dsh-delivery`，不纳入本仓库。

单 HTML 支持独立的用户流程偏好：“不使用 Skill”只禁用 Skill 工具；“不验证/不检查/不测试”进入受控的未验证交付，跳过合同检查、同步后检查和修复，并以 `assurance=unverified`、`syncReceipt.verified=false` 明确标记。产品设计仍在实现前执行，单文件 HTML 不再有专用模型分流。Kimi 实现 Worker 可用 `html_chunk` 按序提交最多 128 块、每块最多 8192 字节的草稿；每块只写入隔离副本，明确 `finish` 后才交给控制器验收和同步。若模型在第一块之前就耗尽输出预算，此机制不能恢复模型未提交的内容。

当前验证器的 Node 路径指向 macOS DSH Desktop 安装目录；迁移到其他机器需要核对该配置。不要提交凭据、会话或缓存。

## 当前多模型路由

DeepSeek V4.1 Flash 总 Agent 负责需求理解、拆分、调度、整合和失败重规划；preset 请求钩子将根会话请求固定为 `deepseek-v4-1-flash`，不修改其他 preset 或子模型。MiniMax M3 的 `task_minimax_design` 负责产品、功能、技术架构、实施和创意方案；Kimi K2.8 Preview（`kimi-k2-8-preview`）优先负责代码、Debug、重构和长上下文代码分析，连续无有效写入时可由受控 DeepSeek Worker 恢复；Kimi K2.7 Code 的 `task_kimi_quality` 负责独立研发验收。GLM `task_glm_vision` 分析静态图片，豆包 `task_doubao_media` 负责动态媒体理解。Seedream/Seedance 分别保留图片生成/编辑和视频生成职责，尚未接入执行适配器；能力查询会明确返回 unavailable。

`multimodel_run` 接受最多 10 个有明确依赖的专业节点，最多并行 3 个；独立失败不会取消其他分支。每个节点拿到独立只读工作副本，完整报告持久化到 `~/.dsh-delivery/specialists/<id>/report.json`，含实际模型标识和输入快照哈希。工具同步返回，不使用旧版后台 jobs 或动态 workflow 脚本。根助手可用 Skill、todo 和提问工具编排任务。

新建交付先进入 design/designing，MiniMax 返回结构化方案并通过校验后才进入实现。方案绑定任务目标与输入快照，持久化并交给每次实现、修复和验收；子任务继承父方案。一般设计失败停止，显式恢复最多再尝试一次；输出 Schema 被 DSH 拒绝时直接失败，不重复相同请求，也不触发模型回退。默认 reviewPolicy=risk_based：方案标记 high 时，必须通过 Kimi K2.7 独立验收后才能同步。风险识别和方案内容仍是模型判断；程序强制结构、归属、完整性和门禁。delivery_review 可额外审查已交付快照，结果单列且不修改已交付文件。历史任务保留创建时的策略。

当前文本/图片输入可进入专业模型，图片依赖宿主附件服务；原生音视频传输、联网搜索和 ArkCLI 图片/视频生成通道尚未接入隔离执行器。对应 Skill 保留并说明边界，不代表已能调用生成服务。历史 DeepSeek→Kimi 研发链证据详见 `tool-delivery-controller/VALIDATION.md`；当前 Kimi Code 实现路由需以本次及后续验证为准，其他专业路由尚未完成真实任务验证。

## 按需协助与证据

小修复也通过 delivery_start，由 MiniMax 给简短方案，再由 Kimi K2.8 实现。需要单独讨论产品设计或分析视觉/媒体材料时，可用 request_capability 或 multimodel_run。交付入口自动生成方案，无需先重复调用设计工具。capability_status 展示实际合同、模型、进度与报告引用；设计方案也随 delivery_status 返回。

实现与限制详见 `tool-delivery-controller/README.md` 的“受控按需协助”。路由是否合理仍需真实案例评估；现阶段优先验证简单 bug 的成功率、人工返工、耗时和调用量，不宣称已实现自动选模优化。

## 当前交付方式

总 agent 汇总交付：`delivery_start(mode=partial)` 在独立副本输出已验收产物；默认 `mode=project` 可用 `sourceDeliveryIds` 汇入同一总会话的分步产物，在沙盒完成配置的本地测试及修复后自动同步当前项目并复核。并行兼容改动自动合并，需要用户取舍的冲突才询问；`delivery_resume` 支持处理决定后的恢复。外部工具尚无操作适配器，不把文件同步冒充外部工具同步。详见 [控制器说明](tool-delivery-controller/README.md)。

工作环境与责任边界见 [交付约定](tool-delivery-controller/WORKFLOW.md)，评价按 [评价制度 v2](tool-delivery-controller/EVALUATION.md) 执行。两份文档随 preset 长期保留；旧 v1 分数与成熟度判断已撤回，保留历史证据供复查。

## 模型日志界面

新增宿主/客户端插件 `dsh-model-logs/`，只在拼好模会话的「上下文」旁显示「模型日志」标签页，记录拼好模及子模型的实际调用状态、耗时、输出摘要和错误，并读取控制器历史验收证据。其他模式不显示该标签。调用成功与输出验收分开展示。部署与保留策略见 [插件说明](dsh-model-logs/README.md)。
