# 拼好模 DSH Agent

本仓库直接维护 DSH Desktop 实际加载的拼好模 preset。

本机目录：`~/Library/Application Support/dsh-desktop/harness/.agent-presets/pin-hao-mo/`

远端：https://github.com/YINGCHAO-98/dsh-pinhaoModel-Agent

## 日常维护

直接在本目录编辑，在 GitHub Desktop 中查看差异、提交并推送。旧工作区副本不再作为运行配置来源。Git 提交不会自动让现有 DSH 会话重载配置。

- `agent.cordis.yml`：当前插件入口、persona 与模型配置。
- `tool-delivery-controller/`：专业模型调度、实现、独立质量门禁、有界修复和持久化审计控制器；说明见该目录 README。
- `delivery-contract.json`：验收命令、受保护路径及修复预算。
- `skills/`：通过 Skill 工具按需加载的角色技能；只加载本 preset 的技能目录。
- `_retired-skills/`、`agent.prompt-based.yml`：历史资料。
- `host/`：保留自之前提交的宿主配置参考快照，不是本机当前宿主配置的实时镜像。
- `snapshot.sha256`：旧版提交的历史校验清单，不用于校验当前控制器版。

明确的自然语言执行需求由模型调用 `delivery_start` 启动交付，也可手动使用 `/deliver start <目标>`。模型可调用 `delivery_status` 查询状态，交付判定由控制器和配置检查决定。运行数据位于 `~/.dsh-delivery`，不纳入本仓库。

单 HTML 支持独立的用户流程偏好：“不使用 Skill”只在执行层禁用根与子模型的 Skill 工具，仍可规划和验证；“不验证/不检查/不测试/不审查”只跳过合同检查、独立审查、同步后检查和修复，仍保留动画方案、隔离实现、文件边界、冲突保护和一致性同步，并以 `assurance=unverified`、`syncReceipt.verified=false` 明确交付。两项偏好可单独或同时使用。

当前验证器的 Node 路径指向 macOS DSH Desktop 安装目录；迁移到其他机器需要核对该配置。不要提交凭据、会话或缓存。

## 当前多模型路由

Kimi Code `kimi-k2.7-code` 负责研发实现和修复。专业入口为 Kimi 研究 `task_kimi_research`（`kimi-k2-8-preview`）、Kimi 质量 `task_kimi_quality`（`kimi-k2.7-code`）、GLM 视觉 `task_glm_vision`（`glm-5-3-flash`）、MiniMax 创意 `task_minimax_creative`（`minimax-m3`）、豆包媒体 `task_doubao_media`（`doubao-seed-2-0-lite-260215`）。全部模型路由当前直接配置在 `agent.cordis.yml` 的 `specialists` 中，不依赖历史文件。

`multimodel_run` 接受最多 10 个有明确依赖的专业节点，最多并行 3 个；独立失败不会取消其他分支。每个节点拿到独立只读工作副本，完整报告持久化到 `~/.dsh-delivery/specialists/<id>/report.json`，含实际模型标识和输入快照哈希。工具同步返回，不使用旧版后台 jobs 或动态 workflow 脚本。根助手可用 Skill、todo 和提问工具编排任务。

新建研发交付在合同检查通过后自动调用 Kimi 独立审查；审查 failed 触发同一个有界修复流程，blocked 不会被当作通过。门禁路由随任务创建保存，历史任务保留原有语义。

当前文本/图片输入可进入专业模型，图片依赖宿主附件服务；原生音视频传输、联网搜索和 ArkCLI 图片/视频生成通道尚未接入隔离执行器。对应 Skill 保留并说明边界，不代表已能调用生成服务。历史 DeepSeek→Kimi 研发链证据详见 `tool-delivery-controller/VALIDATION.md`；当前 Kimi Code 实现路由需以本次及后续验证为准，其他专业路由尚未完成真实任务验证。

## 按需协助与证据

简单 bug 仍直接进入研发交付，不增加规划 Agent。新增 `request_capability` 接收有明确能力缺口的专业申请，`capability_status` 展示控制器记录的合同、实际模型、进度、验收与耗时。旧专业入口和 DAG 共用同一合同及预算，不能绕过检查。已验收的 `artifactRef` 经 `delivery_start.reportRefs` 自动交接给研发。

实现与限制详见 `tool-delivery-controller/README.md` 的“受控按需协助”。路由是否合理仍需真实案例评估；现阶段优先验证简单 bug 的成功率、人工返工、耗时和调用量，不宣称已实现自动选模优化。

## 当前交付方式

总 agent 汇总交付：`delivery_start(mode=partial)` 在独立副本输出已验收产物；默认 `mode=project` 可用 `sourceDeliveryIds` 汇入同一总会话的分步产物，在沙盒完成整体测试、审查及修复后自动同步当前项目并复核。并行兼容改动自动合并，需要用户取舍的冲突才询问；`delivery_resume` 支持处理决定后的恢复。外部工具尚无操作适配器，不把文件同步冒充外部工具同步。详见 [控制器说明](tool-delivery-controller/README.md)。

工作环境与责任边界见 [交付约定](tool-delivery-controller/WORKFLOW.md)，评价按 [评价制度 v2](tool-delivery-controller/EVALUATION.md) 执行。两份文档随 preset 长期保留；旧 v1 分数与成熟度判断已撤回，保留历史证据供复查。

## 模型日志界面

新增宿主/客户端插件 `dsh-model-logs/`，只在拼好模会话的「上下文」旁显示「模型日志」标签页，记录拼好模及子模型的实际调用状态、耗时、输出摘要和错误，并读取控制器历史验收证据。其他模式不显示该标签。调用成功与输出验收分开展示。部署与保留策略见 [插件说明](dsh-model-logs/README.md)。
