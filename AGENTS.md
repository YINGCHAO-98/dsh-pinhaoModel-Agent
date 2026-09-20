# DSH Agent 配置维护规则

本项目用于编写和迭代 DSH Agent preset。

每次修改 `agent.cordis.yml` 后，必须在最终回复中增加“当前已配置的 Tools”小节。

输出要求：

- 修改完成后重新读取 `agent.cordis.yml`，根据文件的最新内容生成清单，不得依赖之前回复中的旧清单。
- 列出配置中当前存在的全部模型可调用 Tool，而不只是本次新增或修改的 Tool。
- 每项至少写出配置 `id`、插件 `name` 和用途；存在关键 `config` 参数时一并列出。
- 不把 `persona`、服务、执行后端、策略、分组或其他非模型调用组件误列为 Tool。
- 如果配置中没有模型可调用 Tool，明确写“无”。
- 该清单用于帮助维护者掌握 DSH Agent 的当前能力，不代表本次任务实际调用过这些 Tool。

示例格式：

```text
当前已配置的 Tools
- tool-example (`@scope/tool-example`)：用途；关键参数：value。
```

## 配置维护位置

本目录是 DSH Desktop 实际加载的拼好模 preset。后续直接维护此目录；原工作区的模型路由目录仅为迁移前的开发副本。运行状态存放在 ~/.dsh-delivery，不属于 preset 配置。
