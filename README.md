# 拼好模 DSH Agent

本仓库直接维护 DSH Desktop 实际加载的拼好模 preset。

本机目录：`~/Library/Application Support/dsh-desktop/harness/.agent-presets/pin-hao-mo/`

远端：https://github.com/YINGCHAO-98/dsh-pinhaoModel-Agent

## 日常维护

直接在本目录编辑，在 GitHub Desktop 中查看差异、提交并推送。旧工作区副本不再作为运行配置来源。Git 提交不会自动让现有 DSH 会话重载配置。

- `agent.cordis.yml`：当前插件入口、persona 与模型配置。
- `tool-delivery-controller/`：实现、验证、有界修复和持久化审计控制器；说明见该目录 README。
- `delivery-contract.json`：验收命令、受保护路径及修复预算。
- `skills/`：辅助说明；当前精简 preset 不自动加载 Skill 工具。
- `_retired-skills/`、`agent.prompt-based.yml`：历史资料。
- `host/`：保留自之前提交的宿主配置参考快照，不是本机当前宿主配置的实时镜像。
- `snapshot.sha256`：旧版提交的历史校验清单，不用于校验当前控制器版。

明确的自然语言执行需求由模型调用 `delivery_start` 启动交付，也可手动使用 `/deliver start <目标>`。模型可调用 `delivery_status` 查询状态，交付判定由控制器和配置检查决定。运行数据位于 `~/.dsh-delivery`，不纳入本仓库。

当前验证器的 Node 路径指向 macOS DSH Desktop 安装目录；迁移到其他机器需要核对该配置。不要提交凭据、会话或缓存。
