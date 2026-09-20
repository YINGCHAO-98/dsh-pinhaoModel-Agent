# 拼好模固定交付控制器

这是一份真实的 DSH 本地 Cordis 插件，不是提示词、MCP 包装或模型生成的 workflow 脚本。当前 `../agent.cordis.yml` 已指向 `./tool-delivery-controller/index.mjs`。

## 本次变更的范围

第一版固定一个实现节点、一个验证节点、最多两轮修复。原多模型配置完整保存在 `../agent.prompt-based.yml`，不由当前 preset 加载。研究、创意、视觉、媒体等角色 Skill 仍保留，但当前交付模式不开放这些委派工具，也不允许根模型直接使用 Shell/文件写入/动态 workflow。根目录的精准读取 preset 与“拆分任务”目录未修改。

模型仍负责理解需求和生成代码。实现/修复 Worker 只返回完整文本文件变更，执行层检查后将变更应用于快照。这让第一版不必给任意模型开放操作系统写权限，代价是不支持大型仓库的交互式探索和二进制修改。

## 启动

1. 使用 Node.js 24+ 和支持 `tools.guard()`、`tools.presentAs()`、用户命令、结构化子 Agent 的 DSH。已对本机 `0.1.5-rc.2` 源码的构建产物做真实接口测试。
2. 把整个“模型路由”目录作为用户 preset 部署/刷新；单独复制 YAML 不够，`tool-delivery-controller/` 和验收合同必须一起存在。宿主提供 `commands`、`tools`、`subagents`，并注册 `spawn` 提供方及配置中的模型路由。无需安装额外 npm 依赖。
3. 在待交付项目目录中启动/创建 DSH 会话并选择“拼好模”。不要把此 preset 的维护目录当作交付项目。验收合同必须位于交付项目之外；状态默认保存在 `~/.dsh-delivery`，也必须在交付项目之外。
4. 维护者按项目修改 `../delivery-contract.json`。默认是小型 Node 项目：只允许修改 `src/`，保护 `tests/` 和包配置，必须已有 `tests/`，执行 `node --test --test-reporter=tap`，至少一个测试通过，最多两轮修复。它不是适用于所有项目的通用验收标准。
5. macOS 使用系统 `sandbox-exec`。Linux/Windows 使用 Docker，须事先准备配置中的 `node:24-bookworm-slim` 镜像；本次未实测 Docker 分支。沙箱不存在、外层沙箱不允许嵌套、镜像缺失等情况会进入 blocked，不会退回无隔离执行。

命令由 DSH 用户命令处理器直接执行，不需要模型选择是否调用工作流：

```text
/deliver start 修复加法函数，使已有正数和负数测试通过
/deliver status
/deliver status <id>
/deliver history <id>
/deliver resume <id>
/deliver cancel <id>
```

`start` 在命令执行期间运行闭环，另一条 status 查询或模型 `delivery_status` 可以读取进度。模型通过 `delivery_start` 将明确的自然语言执行需求交给同一个控制器；普通讨论和状态查询不启动任务。恢复、取消仍使用用户命令。客户端取消执行会传递取消信号。

通过后返回独立 `artifact` 目录，保留原项目不变，便于审阅后接入自己的合并流程。当前没有自动合并、发布或部署。修改导出产物后，下一次查询状态会标记 invalidated；如需继续修改，应创建新的用户任务并重新验证。

## 固化了哪些约束

- **状态机**：模型结束实现只能进入 verify；所有检查通过才能进入 passed。失败自动进入 repair，预算用尽为 failed。
- **工具边界**：preset 选择 native 工具呈现；`tools.guard()` 单调拒绝除 `delivery_start`、`delivery_status` 和受信结构化输出之外的调用，包括继承/后来注册的 Shell、MCP 和 `run_code`。Worker 额外使用空工具 allowlist。结构化输出工具只由 DSH 子 Agent 运行时注册。
- **路径边界**：只接受合同允许的相对路径，拒绝目录穿越、隐藏路径、重复路径、文件/目录冲突、保护文件修改和符号链接。
- **可信验证入口**：argv 来自部署合同，模型不能指定 Shell 命令、跳过检查或改写合同。验证代码运行在独立只读快照；macOS 只给临时目录写权限，禁止网络，限制宿主内容读取；Docker 只挂载快照并禁网。
- **版本绑定**：合同、原始快照、每轮快照都有哈希。检查记录携带快照、命令、实际退出码、输出、时间和运行环境信息。
- **有界执行**：最多两轮修复；总 Worker 调用上限为 `maxRepairs + 3`（给中断恢复留余量），最多六次验证轮次；调用前持久计数；Worker 默认 180 秒，检查使用合同超时。
- **审计**：SQLite WAL + FULL 同步；状态更新与对应事件在同一事务内提交。事件只追加，记录每轮变化和检查结果。工具拒绝另由 DSH 自身的工具执行轨迹记录。

## 恢复语义

每次运行持有基于 SQLite 的工作区锁。同一工作区不能并发执行或用另一个会话新建任务冲掉未完成任务。状态查询和历史读取按 session id 隔离。

重启后在原 DSH 会话中使用 `/deliver resume <id>`。发现持锁进程已经退出时回收锁；活进程或其他主机持锁时拒绝并发接管。PID 被复用时会保守阻塞，避免错误抢占。共享数据库不支持跨主机自动接管。

中断的模型阶段会重新请求纯变更提议；中断的验证会对相同快照重新执行，不复用不完整结果。修复次数不会重置。已 passed/failed/cancelled/invalidated 的任务不会因 resume 重新获得预算。blocked 的恢复继续使用任务开始时保存的合同；维护者修改配置不会降低已有任务的门槛。

## 验收与安全边界

`passed` 只代表配置中的检查通过，不代表所有需求、视觉效果、性能或安全性都已证明。维护者要提供有效测试和验收规则；本控制器不会自动生成一个完整可靠的验收标准。

Node TAP 最小计数用于防止零测试、无报告的提前退出被当作通过，不是对恶意伪造测试报告的完整防护。macOS 实现使用进程组终止超时命令，不宣称能收回恶意自行脱离进程组的所有后代；需要更强进程/资源隔离时使用经过部署验证的容器后端。控制器进程硬崩溃后，不完整验证不会被采信，但本版不提供 macOS 遗留验证进程的跨进程自动清理。不得将示例当成运行敌对代码的完整安全边界。

当前限制：快照最多 1000 个文件/4 MiB，模型文本上下文最多 256 KiB，单轮最多 64 个变更/256 KiB。跳过 `.git`、`node_modules`、`.env*`、`.DS_Store` 和 `.delivery`；不自动安装依赖。验证工作区只读；需要构建缓存或输出时，维护者应配置写入临时目录的检查。Docker 依赖须预置于镜像中。

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

实现文件：`index.mjs`（DSH 接入）、`controller.mjs`（状态编排）、`store.mjs`（事务/状态/事件）、`files.mjs`（快照/路径约束）、`runner.mjs`（隔离验证）。
