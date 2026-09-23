# 产品设计、实现与独立验收（当前默认）

当前 preset 配置 `designTool: task_minimax_design`、`reviewPolicy: risk_based`。流程为 DeepSeek 需求编排 → MiniMax 产品设计 → Kimi K2.8 优先实现 → 本地检查 → 高风险任务 Kimi K2.7 独立验收 → 同步与复核。连续无有效写入并耗尽有界恢复时，控制器可调用一次配置的 DeepSeek 恢复 Worker。低/中风险不自动加入独立模型验收。没有配置本地检查时 `automatedChecks=not_configured`，不得宣称运行了测试。

单 HTML 实现支持 `html_chunk(action=append,index,content)` 分批写入隔离草稿，每块 1..8192 UTF-8 字节，最多 128 块、512 KiB；序号必须连续。`html_chunk(action=finish,index=下一块序号)` 成功回执后才接管草稿，运行原有检查和同步。根 Agent 与其他专家不能调用；模型在首块之前耗尽输出预算时仍按 `WORKER_MAX_TOKENS` 失败，未完成草稿不作为交付物。

产品设计是控制器的 design/designing 阶段，输出包含目标、用户、范围、用户流程、实施方案、验收标准、风险和假设。方案通过结构、模型身份和输入快照校验后持久化；Store 拒绝跳过设计直接实现。一般设计失败阻塞，显式恢复最多重试一次；DSH 报 `UNSUPPORTED_SCHEMA` 时直接失败，避免重复同一配置错误。取消、重启保留状态与预算。子任务继承父方案，修复不重复规划；实现与验收都收到同一方案。报告完整性失败会阻断实现。方案文本不成为 Shell 命令、修改权限或强制验收项；仅用户任务合同及部署合同中的验收项进入状态清单。风险等级为模型判断，程序只保证 high 必须经过验收，不保证模型能识别所有风险。

所有模型角色由本 preset 固定：根请求钩子只路由 DeepSeek 总 Agent；Kimi K2.8 是首选实现模型，DeepSeek 恢复 Worker 仅在前者无有效写入并耗尽有界尝试后运行一次；MiniMax/GLM/豆包均只读，只有 Kimi K2.7 验收者可在只读工作区运行检查。Seedream 图片生成、Seedance 视频生成、豆包原生音视频输入在能力查询中显式 unavailable，不能通过其他模型伪装完成。

`delivery_review({id})` 仅接受当前会话已经完成的交付，审查已交付的不可变快照，并提供本次变更路径。审查报告独立持久化于事件表，不修改交付状态或文件，不触发实现与修复。`verification.independentReview` 初始为 `not_requested`；超时、取消、不可用或无效报告为 `incomplete`，原因由 `review.reasonCode` 给出。完整报告可通过 `artifactRef` 追溯。项目后来有变更时 `projectMatchesReceipt=false`，旧快照审查不代表当前项目。

`required` 仍可作为部署策略使用，历史任务保留创建时的门禁，不自动降低已有任务的保证。策略与路由不可通过状态更新修改。以下旧版门禁流程仅适用于 required 策略。

## Task IR 与 Contract Compiler（架构调整 P0）

`delivery_context` 和 `delivery_start` 共用 `task-ir.mjs` 的编译入口。前者只预览，后者在真实工作目录解析后重新编译，再登记任务和调用 Worker。可选 `context` 描述约束、路径、公开接口、验收条件和交付物；`objective` 成为统一 `goal`。`steps`、执行者选择、模型与工具注册、检查命令等字段不能通过 context 注入。根模型仍通过现有工具决定是否自行完成、委派和组织依赖。

```json
{
  "objective": "修复订单优惠与退款计算",
  "context": {
    "constraints": { "runtime": "Node 18+", "module": "CommonJS", "externalDependencies": false },
    "editablePaths": ["src/**"],
    "protectedPaths": ["tests/**", "docs/**"],
    "requiredInterfaces": ["quote", "createRefundState", "refund"],
    "acceptanceCriteria": ["public-tests", "退款必须幂等"],
    "deliverables": ["修复后的退款实现"]
  }
}
```

路径以所选 `projectRoot` 为根。支持精确路径、目录前缀、`**` 和尾部 `/**`；其他 glob 拒绝。context 只能收紧部署的可编辑范围、增加保护路径，不能放宽边界。编译后的路径约束进入实际变更校验与同步流程。

部署文件仍独占可执行 `checks` 的定义；编译结果补齐绝对 `projectRoot`、`checkIds` 和配置能力信息。验收字符串与已注册 check ID 完全一致时绑定该检查。Task 请求未注册的合法 ID 时，编译器移除其执行引用，保留 `requestedCheckId`、原因和文本验收项，不猜测或执行 `npm test` 等命令。当前没有开放临时检查创建权限。任务 `checkIds: []` 表示子任务无选定检查；父交付依然执行部署契约的全部检查。

统一 `taskIR` 持久化到 run 并写入 `contract.compiled` 审计事件，随 Worker 的实现与修复输入传递，状态更新不能篡改它。`delivery_status` 的 `acceptance` 逐项返回 `passed`、`failed` 或 `not_verified`，只有当前快照的真实检查结果可标记通过。文本验收不会因模型自述或同步成功变成通过；存在未验证项时，即使文件交付状态是 `passed`，也返回 `acceptanceComplete=false` 和 `nextAction=root_acceptance_required`。没有验收条目时 `acceptanceComplete=null`，不作语义完成保证。

本阶段没有实现自然语言语义验证：`constraints`、接口和交付物描述保留为未验证文本；P2 再引入专用可执行断言。P1 的完整 Decision Trace、统一异构 TaskNode，以及 P2 的动态重规划和完整 Capability Registry 尚未实施。已有专业 DAG、Worker 任务调度、审查选择和恢复机制继续保留，不能将本次 P0 记录称为完整架构重构完成。

验收记录见 [Task IR P0 验证](validation/task-ir-p0-20260922.md)。修改源码不保证已运行会话热重载；新会话或重新加载 preset 后使用新入口。

# 拼好模交付 Runtime

交付开始后，控制器直接通过宿主原生 `todo/write` 事件更新 Todo 面板：准备输入、实现/修复、合同检查、同步复核（required 策略另含独立审查）。已登记 `tasks` 时逐项显示实际目标及执行状态。没有登记业务子任务时仅展示执行阶段，不假称已自动完成业务拆分。状态每秒检查一次，等待期间耗时每 15 秒更新，不追加模型上下文，不增加模型调用。失败、阻塞和取消显示原因且不标记完成；交付结束清理计时器。首个工具调用之前的模型推理不在控制器可观测范围内。

Worker 的 `max-tokens` 属于本次生成失败。仅当隔离工作副本未被修改时，控制器在原交付内有界重试一次；仍无进展时可使用一次已配置恢复 Worker。已有写入或预算耗尽则终止，不重复不安全的草稿。本规则不改变普通测试失败的有界修复，也不改变沙箱暂不可用等环境阻塞的恢复。

实现优先使用 Kimi K2.8 Preview。单 HTML 改变工具范围和验收合同；若首选 Worker 的有界尝试均未产生有效写入，控制器可派发一次 `recoveryWorker`，沿用相同工作副本、写入范围和检查。旧的 singleHtmlWorker/workerFallback/singleHtmlReasoningEffort 配置仍被拒绝；根模型 write/edit 在工具策略与执行入口均拒绝。输出超限或无工具恢复耗尽时返回精简失败状态，并在本轮隐藏 delivery_start，保留只读查询；下一条真实用户消息解除启动限制。

更新已有单 HTML 时，若可绘制/交互元素与具名 CSS 类同时大幅减少，控制器将 `single-html` 检查标记为 `HTML_STRUCTURE_REGRESSION` 并进入修复或失败，不允许静默同步。这是通用的严重截断防线，不是视觉或语义正确性的证明；合法的大规模重写也可能被保守拦下，需要调整交付范围或另行验收。

根 Agent 可调用 `delivery_cancel({id})` 结束本会话的交付，无需让用户手输命令。活动任务先停止并等待清理；重复取消终态任务返回现有状态。取消不删除项目文件，不撤销已同步修改，不能取消其他会话或独立取消必需子任务。新建交付时，在工作区锁内自动将本会话同工作区旧版 `Worker did not complete: max-tokens` 阻塞记录转为失败，保留历史，允许替代交付；真实环境故障、冲突与其他会话记录不会被自动解除。

用户点击停止、调用 `delivery_cancel` 或删除会话时使用同一所有者生命周期清理。控制器以全局观察者监听 DSH `session/disposed` 硬事件（普通 preset 作用域监听无法收到其他 session carrier 的销毁事件），不依赖模型输出清理指令：立即中止本会话活动交付和专业模型，级联取消父任务与未完成子任务，拒绝待处理冲突决策，等待工作区和锁释放，清除 Todo 投影、启动预留、动画写入保护、动画上下文与当前轮 Skill 禁用标记。新交付开始前还会在工作区锁内检查历史占用的 owner；owner 已不在 DSH 活会话表时，控制器把其未完成父任务及子任务取消后再创建新交付，因此旧版本遗漏的删除事件不会永久卡住该目录。仍存活的其他会话继续受互斥保护。已经同步到项目的文件不自动回滚。

这是一份真实的 DSH 本地 Cordis 插件，不是提示词、MCP 包装或模型生成的 workflow 脚本。当前 `../agent.cordis.yml` 已指向 `./tool-delivery-controller/index.mjs`。

用户确认的工作环境、总 agent 与子 agent 的责任边界见 [交付约定](WORKFLOW.md)；评价标准见 [评价制度](EVALUATION.md)。本页说明对应的执行机制与工具用法。

## 受控按需协助（当前实现）

根助手负责专业分工和结果整合。文件交付统一先产品设计，再进入实现；小任务的方案保持简短。高风险使用 risk_based 验收门禁，额外交付后审查通过 delivery_review 发起。

- `request_capability` 提交能力、目标、理由、专业协作相对单模型执行的价值、输入引用、预期产物与验收条件。这个价值可以是能力缺口、更好的领域匹配、独立视角或并行提速。能力定义与工具描述来自 `capabilities.mjs`，实际模型由 YAML 映射。
- 原 `task_*` 为同一受控入口的兼容名称，参数除隐含 capability 外完全相同；不能绕过合同或预算。DAG 节点也必须提交理由和交付约定，不再接受只有 objective 的旧参数。
- 根助手可申请已注册能力；实现 Worker 只能申请辅助研究、创意、视觉、媒体分析，不能自行触发独立审查。专业节点和审查节点不能继续委派。辅助子 Agent 由控制器以根 Agent 身份启动为兄弟节点，调用者身份、工作区、交付 ID 由运行时绑定，模型不能指定。
- 输入仅接受 `file:相对路径` 与已验收的 `report:任务ID`。报告绑定会话身份并校验文件哈希；篡改或删除后失效。`delivery_start.reportRefs` 自动加载完整报告，修复轮自动恢复本交付已接受的辅助报告，缺失、失败或未完成的必需辅助任务会阻止交付通过。
- 请求记录进入独立 `capabilities.sqlite`。状态为 running → submitted → validating → accepted / failed / blocked；取消为 cancelled，已验收报告被修改为 invalidated。模型只能提交 status，最终状态由控制器设置。
- 控制器检查报告结构、实际图片传递、资料读取和审查命令执行记录。语义正确性仍是模型判断，不声称规则可以证明文案质量、研究结论或完整需求覆盖。自述 evidence 与控制器 execution 记录分开保存。
- `capability_status` 返回实际请求合同、选用模型、事件、耗时、宿主提供的 Token 用量及可传递的 `report:` 引用；控制器私有的绝对报告路径不暴露给根 Agent。`delivery_status` 包含关联专业任务。Token 未提供时为 null，不估算成真实费用。目前是工具输出的进度展示，没有修改 Desktop UI。
- 专业调用最多并发 3 个；每个研发交付最多 `maxCapabilityCalls` 次（默认 12，包括该交付的质量审查），跨修复和恢复累计。根助手在同一会话直接发起的专业请求与 DAG 共用会话级 12 次预算；独立根会话是新范围。完全相同的请求和输入快照拒绝重复调用，应复用已验收报告。失败记录不重置预算，也不自动重试。
- 持久状态不等于自动续跑：中断的专业任务不会静默重新调用模型；未接受的必需辅助任务阻止当前交付，需要排查后启动新任务。调用理由必须存在，但其合理性需要真实案例评估，尚无自动路由评分或跨会话学习。

示例：

```json
{
  "capability": "visual_analysis",
  "objective": "提取参考图的布局差异",
  "reason": "页面修复需要实际截图证据",
  "singleModelGap": "当前实现 Worker 没有图片输入工具",
  "inputRefs": ["file:reference.png"],
  "expectedOutput": "布局、间距和配色分析",
  "acceptanceCriteria": ["结论引用实际可见元素"]
}
```

图片生成、原生音视频与联网研究没有注册为可调用能力；请求不能伪装成已完成的生成交付。

## 原有执行机制

当前实现包含 Kimi K2.8 首选研发 Worker 和一次性 DeepSeek 恢复 Worker、四个专业入口 task_minimax_design/task_kimi_quality/task_glm_vision/task_doubao_media、专业 DAG 调度及风险验收。模型与角色全部在 `../agent.cordis.yml` 配置；历史 `agent.prompt-based.yml` 不参与加载。根助手通过 delivery_*、request_capability、capability_status、multimodel_run、skill、todo_write 和 ask_user_question 编排。专业工具共用隔离适配器，不挂载不受控文件/Shell 插件。

`multimodel_run` 参数为 `{nodes:[{id,tool,objective,dependsOn}]}`，最多 10 个节点，启动前拒绝重复 ID、未知依赖和环；同一 DAG 使用一个输入快照，依赖报告自动传入下游，各节点使用独立只读副本。所有专业调用（包括自动 Kimi 门禁）共用最多 3 个并发槽位。失败节点只阻断下游。单次调用超时含排队时间，取消时清理等待、子 Agent 和副本。

专业模型默认允许 `read/glob/grep/bash/snapshot_explore/read_image/skill`，GLM 视觉角色通过路由 `tools` 白名单移除 bash，直接根据 read_image 的实际图像输出结论，避免不必要的解码和依赖诊断。各路由可配置这些工具的子集；禁止写副本和继续委派；Shell 写入也受 Seatbelt 只读策略限制，测试临时文件可写 `$TMPDIR`。`structured_output` 返回完整报告，控制器落盘到 `specialists/<id>/report.json`，返回模型、输入快照和报告路径。`read_image` 只读取该子 Agent 输入快照中的图片，经宿主附件服务保存并传入模型；无附件服务时明确报错。当前不传原生音视频，也没有联网研究或 ArkCLI 生成通道。

实现/修复 Worker 现在在每轮独立的临时工作副本中开发：复用 DSH 原生 `read/write/edit`、`glob/grep` 和 `bash`，完成后只返回结构化摘要。控制器收集实际文件差异、检查合同、冻结快照并独立验收。`snapshot_explore` 保留为读取本轮初始快照的补充工具；无需全量文件进入提示。仍不支持二进制变更。

`read` 会把模型从 Markdown 文本复制出的标点转义还原，例如 `BUSINESS\_RULES.md` 按 `BUSINESS_RULES.md` 处理。若相对路径在会话根目录不存在，Runtime 会在工作区内按完整路径后缀查找；只有唯一候选时自动读取，例如把 `docs/BUSINESS_RULES.md` 定位到 `demo1-candidate/docs/BUSINESS_RULES.md`。多个项目存在同名候选时拒绝猜测并列出候选。该恢复仅用于只读操作，不会模糊匹配写入、编辑或 Shell 工作目录，也不会跟随符号链接或越过工作区。

## 启动

1. 使用 Node.js 24+ 和支持 `tools.guard()`、`tools.presentAs()`、用户命令、结构化子 Agent 的 DSH。已对本机 `0.1.5-rc.2` 源码的构建产物做真实接口测试。
2. 把整个“模型路由”目录作为用户 preset 部署/刷新；单独复制 YAML 不够，`tool-delivery-controller/` 和验收合同必须一起存在。宿主提供 `commands`、`tools`、`subagents`，并注册 `spawn` 提供方及配置中的模型路由。无需安装额外 npm 依赖。
3. 在待交付项目目录中启动/创建 DSH 会话并选择“拼好模”。不要把此 preset 的维护目录当作交付项目。验收合同必须位于交付项目之外；状态默认保存在 `~/.dsh-delivery`，也必须在交付项目之外。
4. 默认 `../delivery-contract.json` 使用通用工作区合同（`layout: workspace`）：不要求 `src/`、`tests/`、包配置或任何固定测试命令。`editablePaths: ["**"]` 允许工作区内普通文件；路径边界、隐藏/二进制文件限制、任务范围和冲突保护仍生效。实现器按实际项目执行适用检查，未运行的检查不得声称通过。维护者仍可配置专项合同的保护路径、必要输入和固定检查；这些明确配置不会被自动删除。
5. 当前 Worker 原生工具适配器支持 macOS Seatbelt，配置中的 `runtimePackageJson` 指向本机 DSH 安装包，`sandbox.nodeExecutable` 指向其 Node。Docker 验证 Runner 保留，但 Docker Worker 工具运行时尚未接入，非 macOS 任务会 blocked；不回退到宿主直接执行。沙箱不可用或外层禁止嵌套时同样 blocked。

单 HTML 创建或修改可使用 `delivery_start({objective: "原始目标与约束", singleHtmlPath: "pelican-bicycle.html"})`。控制器先设计方案，再在内置 HTML 合同下实现，只允许修改目标文件，禁止额外文件、删除交付物、路径穿越和多任务/产物导入。默认检查 HTML 结构与脚本并同步复核；结构检查不证明图形正确或动画流畅。简单修改仍走同一 Kimi K2.8 实现入口。

用户明确“不使用 Skill”时，根与子模型的 skill 工具在该轮禁用。明确“不验证/不检查/不测试”时，独立 project 单 HTML 可启用 assurance=unverified：保留产品设计、隔离实现、路径边界、冲突保护与快照一致性同步，跳过检查、独立验收和自动修复；结果明确记录 verified=false。

命令由 DSH 用户命令处理器直接执行，不需要模型选择是否调用工作流：

```text
/deliver start 修复加法函数，使已有正数和负数测试通过
/deliver status
/deliver status <id>
/deliver history <id>
/deliver resume <id>
/deliver cancel <id>
```

`start` 在命令执行期间运行闭环，另一条 status 查询或模型 `delivery_status` 可以读取进度。模型通过 `delivery_start` 将明确的自然语言执行需求交给同一个控制器；普通讨论和状态查询不启动任务。恢复可使用 delivery_resume 或用户命令；取消使用用户命令。客户端取消执行会传递取消信号。

`delivery_start.tasks` 可登记最多 10 个必需实现任务，总上下文不超过 128 KiB；省略时保留简单任务直接执行路径。每项包含 `id/objective/context/interfaces/acceptanceCriteria/editablePaths/dependsOn`，可选 `checkIds` 只能从部署合同中选择现有检查。控制器持久化父任务、子任务 ID、不可变任务清单和合同；子任务修改范围不能扩大，依赖不能有环或缺项。登记子任务按清单顺序严格串行，每次只派发一项；依赖产物自动进入下游副本，子任务只接收自身合同与必要上游结果。

父任务先处于 collecting。所有登记子任务都通过且产物完整后，控制器才进入总任务实现/集成及完整验收。状态机在进入实现、验证、同步和完成时检查必需任务集合，拒绝删项、换归属、用 failed/blocked/被篡改产物凑齐。模型不能直接启动登记子任务，也不能把其他父任务的子产物导入新的交付；根会话不能通过新建整体交付绕过未结束的总任务。

`delivery_start` 默认 `mode=project`：沙盒验收后自动同步当前项目，并对从实际项目重读的快照执行合同检查。`mode=partial` 只导出独立 `artifact`，不回写项目。同一总会话可发起多个 partial；使用 `sourceDeliveryIds` 汇入其已通过且未篡改的产物，任务必要上下文和验证证据传给集成 Worker，重新整体测试/修复和独立审查。

同步使用原始、交付、当前三个版本：保留无关改动，使用本机 Git merge-file 自动合并同文件非重叠文本改动。重叠修改、二进制/增删冲突保存为 blocked；控制器直接通过宿主 userQuestions.ask 展示具体版本并接收选择。模型工具已删除 conflictResolutions，运行时也拒绝这类额外参数。每次问题生成唯一 ID，回答绑定会话、交付和版本，消费一次；取消、空白、自定义但无法解释的回答、错误问题 ID 和等待期间项目变化均不能授权。根助手可用 delivery_resume 恢复已有任务；首次汇入冲突也先保存任务，再走同一用户交互路径。文件/目录结构冲突需要先解决结构，不能用单文件选择强行覆盖。

同步计划先持久化到 SQLite，再逐文件比较和替换；恢复允许已应用字节，不覆盖第三个版本。同步后重新读取、运行固定沙盒检查，再核对当前项目与已验收版本一致才返回 passed。`syncReceipt` 记录版本和变动路径，`projectMatchesReceipt` 单独报告查询时是否仍一致。若中途失败或取消，已应用文件保留在日志中，不能声称从未同步或自动回滚了全部文件。

这是逐文件更新，不是文件系统多文件事务；控制器锁约束共享状态目录的整体交付，无法让不遵守锁的外部编辑器参与原子事务。目录链接与文件版本会重复检查，事后复核能发现偏离，但不能承诺抵御恶意进程在最后检查与 rename 之间精确竞态。新增文件默认 0644，已有文件保留执行权限；不管理扩展属性。仍受原有快照大小、排除目录和二进制编辑限制。

当前没有发布、部署、任务看板等外部操作适配器。只有真实接入并有结果核验的操作才可声明工具同步成功。修改导出产物后，下一次查询状态会标记 invalidated；如需继续修改，应创建新的用户任务并重新验证。

## 固化了哪些约束

- **状态机**：新建交付从 design/designing 开始，方案成功才可实现。verified 交付在合同检查与适用的独立验收通过后才能同步；risk_based 策略对 high 方案启用验收门禁。历史 required/on_request 任务保留既有策略。仅明确取消验证的受限单 HTML 使用 unverified，Store 只接受空验证证据、空质量报告和 verified=false 回执。
- **工具边界**：根助手使用交付、专业委派、DAG、Skill、todo 和提问入口。用户当前请求明确禁用 Skill 时，同一执行策略对根和所有子会话隐藏并拒绝 `skill`，其他环节不受影响。执行工具要求控制器绑定的活跃子会话身份；Worker allowlist 包含六个原生工具、`snapshot_explore` 和受控 `request_capability`，禁止任意委派、提权、后台任务、MCP 和 `run_code`。结构化输出由受信子 Agent 运行时注册。工具注册器/管理界面可列出注册定义，但发送给根助手模型的工具 schema 会按角色过滤；执行时仍使用同一策略检查权限。
- **Worker 隔离**：原生工具的 schema、编辑和搜索实现复用安装包；每次执行在独立 Seatbelt helper 进程内运行，允许读系统运行库和 DSH 运行时，允许写工作副本和临时目录，禁止网络和工作区外私有文件读取，不继承宿主环境变量。文件路径限定在工作副本，拒绝路径中的符号链接。Shell 可在整个副本内调试，最终差异必须符合合同（包括保护文件）；每轮结束撤销工具访问、收集差异并删除临时副本。
- **原生适配范围**：保留原生 read/write/edit/glob/grep/bash 的参数、执行和结果格式。helper 不挂载跨调用文件观察策略或附件服务；专业模型的 read_image 由控制器单独读取不可变快照并接入宿主附件服务；edit 的字面量唯一匹配仍由原生实现校验。搜索输出超过原始捕获预算会报错，需缩小范围；不提供完整输出落盘链接。
- **路径边界**：只接受合同允许的相对路径，拒绝目录穿越、隐藏路径、重复路径、文件/目录冲突、保护文件修改和符号链接。
- **可信验证入口**：argv 来自部署合同，Worker 可用 Shell 自测，但不能改变最终验收 argv、跳过检查或改写合同。验证代码运行在独立只读快照；macOS 只给临时目录写权限，禁止网络，限制宿主内容读取；Docker 只挂载快照并禁网。
- **版本绑定**：合同、原始快照、每轮快照都有哈希。检查记录携带快照、命令、实际退出码、输出、时间和运行环境信息。
- **有界执行**：最多两轮修复；总 Worker 调用上限为 `maxRepairs + 3`（给中断恢复留余量），最多六次验证轮次；调用前持久计数；当前 preset 每轮 Worker 600 秒；Shell 默认 30 秒、上限 60 秒，输出有上限；检查使用合同超时。
- **审计**：SQLite WAL + FULL 同步；状态更新与对应事件在同一事务内提交。事件只追加，记录每轮变化和检查结果。工具拒绝另由 DSH 自身的工具执行轨迹记录。

## 恢复语义

每次运行持有基于 SQLite 的工作区锁。同一工作区不能并发执行或用另一个会话新建任务冲掉未完成任务。状态查询和历史读取按 session id 隔离。

工作区预留保存在 `~/.dsh-delivery`，不随项目目录清空或新建会话消失。为避免“新会话状态为空但旧任务仍阻塞”的死锁，启动新 project 交付时会自动终结已经超过冷却时间、仍停在 implement、快照未变化、没有验证/修复/同步/冲突/子任务/导入产物的预执行占位，并记录 `reservation.expired`。仍在冷却或已经产生实现、验证、冲突与同步状态的任务不会自动释放；阻塞错误会返回具体 delivery id、状态以及是否属于其他会话。

重启时，若持锁进程已退出或已无持锁者，持久化的 `implementing/repairing/verifying` 会被硬性收敛为带原阶段的可恢复 `blocked`，避免界面长期伪装成正在运行。之后在原 DSH 会话中使用 `/deliver resume <id>`。活进程或其他主机持锁时拒绝并发接管。PID 被复用时会保守阻塞，避免错误抢占。共享数据库不支持跨主机自动接管。

中断的模型阶段会重新请求纯变更提议；中断的验证会对相同快照重新执行，不复用不完整结果。修复次数不会重置。已 passed/failed/cancelled/invalidated 的任务不会因 resume 重新获得预算。blocked 的恢复继续使用任务开始时保存的合同；维护者修改配置不会降低已有任务的门槛。

## 验收与安全边界

`passed` 只代表配置中的检查通过，不代表所有需求、视觉效果、性能或安全性都已证明。维护者要提供有效测试和验收规则；独立 Kimi 审查也不是完备性证明，本控制器不会自动生成一个完整可靠的验收标准。

Node TAP 最小计数用于防止零测试、无报告的提前退出被当作通过，不是对恶意伪造测试报告的完整防护。macOS 实现使用进程组终止超时命令，不宣称能收回恶意自行脱离进程组的所有后代；需要更强进程/资源隔离时使用经过部署验证的容器后端。控制器进程硬崩溃后，不完整验证不会被采信，但本版不提供 macOS 遗留验证进程的跨进程自动清理。不得将示例当成运行敌对代码的完整安全边界。

当前限制：Worker 执行链仅支持 macOS；快照最多 1000 个文件/4 MiB，取消原有全量文本 256 KiB 输入门槛，单轮最多 64 个变更/256 KiB。跳过 `.git`、`node_modules`、`.env*`、`.DS_Store` 和 `.delivery`；不自动安装依赖。验证工作区只读；需要构建缓存或输出时，维护者应配置写入临时目录的检查。Docker 依赖须预置于镜像中。

## 按需代码探索

初始 Worker 提示仅携带任务、合同、验证证据、工作副本路径和快照访问凭证/文件数。原生文件工具读取最新工作副本，`snapshot_explore` 读取本轮开始时的固定快照。`snapshot_explore` 支持：

- `list`：可选路径前缀，每页最多 20 个文件及大小/二进制标记。
- `search`：字面量搜索，可选路径前缀，每页最多 20 个命中行，返回路径、行号、列号、短片段和可直接读取的 `readOffset`；不执行正则或 Shell。
- `read`：精确相对路径，按 UTF-16 字符偏移分页，每页最多 4000 字符；二进制文件只列元信息。

`offset` 从 0 开始，使用返回的 `nextOffset` 继续，直到为 null。读取对象来自控制器持有的不可变快照；修复阶段重新绑定修复前的当前快照。工具无法读取任意宿主文件或写文件。探索调用仍受当轮 300 秒超时限制；这不是自动上下文压缩，长对话的上下文管理仍由宿主负责。

## 测试

在此目录执行：

```sh
npm test
npm run test:sandbox
DSH_SOURCE=/absolute/path/to/deepseek-harness npm run test:dsh
DSH_SOURCE=/absolute/path/to/deepseek-harness npm run test:dsh-e2e
npm run demo
```

`test:dsh` 使用真实 DSH 工具注册器验证工具拒绝。`test:dsh-e2e` 加载真实 preset/YAML、用户命令、Agent 循环、spawn 提供方和结构化输出，运行真实沙箱与 Node 测试；只有 LLM 响应使用确定性模拟，不调用付费模型。

`demo` 首轮故意保留错误实现，验证失败后提交修复，输出完整状态、审计事件和临时产物路径。同样是模拟变更提议 + 真实测试，不得声称为 DeepSeek 实际生成结果。

实现文件：`capabilities.mjs`（能力合同、预算、验收与产物交接）、`specialists.mjs`（专业路由、DAG 与报告）、`index.mjs`（DSH 接入）、`controller.mjs`（状态编排）、`store.mjs`（事务/状态/事件）、`files.mjs`（快照/路径约束）、`runner.mjs`（隔离验证）、`explore.mjs`（只读快照探索）。

## 真实模型端到端验证

手动执行 `DSH_LIVE=1 npm run test:live`。此命令调用付费真实模型，不包含在默认测试中。运行器使用已安装 DSH 的生产 AgentLoop、pi-ai 适配器、凭据服务和 preset 加载器；读取当前宿主配置，不复制或打印 API Key。

历史在线场景使用 DeepSeek 根 Agent 和 Worker 接收修复加法函数的自然语言需求，并由 Kimi 独立审查。当前正式路由已切换为 Kimi Code；旧场景只保留为历史回归入口，不能代表当前默认模型验证。运行器独立断言交付 passed、质量快照匹配、导出代码四组输入结果、当前项目同步结果及既有测试未变。每次运行保留临时目录中的 report.json、trace.json、控制器状态与产物，失败也保留证据。

可用 `DSH_RUNTIME` 指定 DSH 安装包 package.json，用 `DSH_LIVE_HOME` 指定包含 settings.yaml 和 .credentials.yaml 的宿主目录。测试目录及状态目录均独立生成，不操作正在使用的会话。在线脚本中的模型断言应在运行前与当前 `agent.cordis.yml` 对齐；其他专业模型也不能因旧场景通过而视为已验证。

多模型整链历史验证入口：`DSH_LIVE=1 npm run test:live:multimodel`。它仍按当时的 DeepSeek 根模型和实现模型断言运行，需更新后才能作为当前 Kimi Code 路由的正式证据。场景挂载真实附件服务并检查依赖报告传递、并发区间、最终页面和测试完整性；错误尝试不计为通过。

项目同步最多 3 次，集成重算最多 6 次，固定验收和同步后检查各最多 6 次；持续变化会明确 blocked，不无限重试。老记录未含 mode 时维持原导出语义，不追溯回写项目。

required 或 risk_based 高风险交付的质量审查遇到相同输入版本、目标及模型时，可复用已验收且哈希完整的报告；固定检查仍实际执行。额外的 delivery_review 在交付完成后单独记录，不改变已交付文件状态。

任务合同的存在、范围和依赖可强制校验；拆分是否合理、上下文是否在语义上充分、自然语言验收条件是否完全覆盖仍需模型判断和实际评估。用户选择的可信边界是已配置的宿主用户交互服务，不能把模型转述、普通提问工具结果或任意传入的字符串当作授权；未接入该服务时保持 blocked。

## 快照范围与预算（2026-09-20 更新）

早期 4 MiB/1000 文件限制已替换：项目快照默认 256 MiB/10000 文件，由部署文件 `snapshot-policy.json` 配置，上限校验为 512 MiB/50000 文件。排除 `.npm-cache` 等依赖缓存，不按扩展名丢弃代码、测试或媒体。收集 Worker 实际变更和验证产物仍完整扫描，不能通过缓存名称绕过检查。

非质量专业任务仅采集 `inputRefs` 的 `file:` 文件；纯报告或纯文本创作不打包项目。需要多份材料时须显式引用全部文件。质量审查与研发交付继续使用完整快照。DAG 采集文件引用并集；包含质量审查节点时采集完整项目。

先检查元数据预算，再读取文件内容；超限返回 `SNAPSHOT_BUDGET_EXCEEDED`，报告路径、单文件字节数、累计大小、文件数和上限，不返回截断快照。变更后需完整重新加载 preset 或重启 DSH。


### 2026-09-21 单 HTML 延迟与上游恢复策略

单 HTML 与普通工程均先使用 Kimi K2.8；只有无有效写入且有界恢复耗尽时，控制器才启用配置的恢复 Worker。权限、写入范围、结构检查与同步门禁保持原样。

Worker / reviewer 失败从子会话真实 turn/end 读取原始诊断（含 Request ID），避免只报告 `Worker did not complete: error`。流式空闲超时设置 120 秒冷却；request burst / rate limit / overload 设置 300 秒冷却。冷却按 provider/model 存入 delivery.sqlite，立即 resume、重启控制器、取消后新建交付均不会绕过对应模型的 Worker 冷却。主模型仍可报告现状，其他模型路由不受该记录阻断。单次交付发生第二次这类上游失败后终止为 failed，不能靠 resume 无限重启。

`WORKER_NO_TOOL_DEADLINE`、`WORKER_TOOL_DEADLINE` 与 `WORKER_MAX_TOKENS` 会终止当前交付，状态返回 `retryableNow=false`。无工具或只读恢复耗尽后，本轮禁止新建交付；下一条真实用户消息可重新开始。并发锁、未完成交付占用、供应商冷却和冲突保护仍由控制器执行，避免无界重试或覆盖文件。

`DSH_LIVE=1 node tests/live-pelican.mjs` 运行原始不验证的直接生成案例；设置 `DSH_PELICAN_FULL=1` 则运行单 HTML project 实现、检查、独立审查与同步。在线测试只在显式授权下运行，凭据使用本机 DSH 凭据服务；产物与状态隔离在临时目录，记录真实阶段耗时。

固定单 HTML 合同的实现 Worker 只开放 read/write/html_chunk，禁止 shell 自检；html_chunk 按序分块并在 finish 后提交完整草稿。控制器等待目标文件真实 write 成功回执，撤销后续工具调用、停止实现子会话、收集工作副本作为未验收草稿，再进入固定检查。伪造完成、写错文件或工具失败不会触发交接。修复时也提交完整文件，仍受原修复次数预算约束。需要独立 Kimi 审查时，在交付后另行调用 `delivery_review`。通用工程 Worker 保留原工具集。

单 HTML 固定检查额外拒绝已复现的 SVG 定位属性与同元素 CSS transform 动画覆盖冲突；错误信息引导将定位放在外层、动画放在内层。该检查是保守的局部静态规则，不能代替真实浏览器渲染，也不能验证全部动画几何关系或审美。

Worker 文件工具的相对路径以任务工作区为根；`/workspace/...` 是该隔离工作区的稳定虚拟别名。若模型传入根 Agent 当前项目内的绝对路径，控制器将其映射到隔离副本的同一相对位置，不直接改写宿主项目。临时文件使用 `$TMPDIR/...`、`${TMPDIR}/...` 或 `/scratch/...`（只展开这些内建别名，不执行 shell/environment 插值）；Shell 提供同一 TMPDIR 与 DSH_WORKSPACE。其他绝对路径、跨任务、越界与符号链接访问保持拒绝。质量报告由控制器写入 `stateDir/specialists/<task-id>/report.json` 并在内部校验哈希，只向根 Agent 返回 `report:<task-id>` 引用，不由模型写入项目 `/reports`；主模型状态结果与实现修复输入只接收有限质量摘要，不重复传入 execution 原始代码轨迹。

### 工作区与交付位置（2026-09-22）

默认与原生文件工具一致，以会话 cwd 为根，不根据目录名称自动猜测项目。`delivery_context({})` 返回真实交付目录、可编辑范围及合法检查 ID。位于子目录的文件使用工作区相对路径，例如 `candidate/lib/main.py`；需要将整个执行上下文切入子项目时显式传 `delivery_start({objective, projectRoot: "candidate"})`。此时快照、实现、独立审查、检查和同步都以该目录为根，状态中的 `deliveryDirectory` 返回绝对写回位置。子目录参数拒绝绝对路径、`..` 和符号链接。

没有固定检查时，状态明确返回 `verification.automatedChecks: "not_configured"`，`checks` 为空；独立审查结论单列，不能将控制器 passed 解读为自动测试通过。单 HTML 专项输出合同继续约束其指定产物。

### 实现超时恢复（2026-09-22）

`workerTimeoutMs` 为实现总时限，默认 600000ms。单 HTML 另有 120 秒首工具期限与 180 秒首有效写入期限；供应商 stream idle timeout 继续单独检测无输出。控制器对已确认没有完成工具调用的执行超时/供应商 TIMEOUT，在原交付内自动重试一次，持久化 `executionRetries`，复用上游报告并保留检查和同步限制。重试输入收敛冗余而不能删减必要行为。重试前旧子模型和工作副本已销毁；取消、已经写入草稿或限流不会进入此自动恢复路径；仅零写入的输出超限或只读超时可有界恢复。耗尽后失败码为 `WORKER_TIMEOUT_RETRIES_EXHAUSTED`，不能通过同轮新建交付重置预算。
