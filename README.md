# 拼好模 DSH Agent

当前 DSH Desktop 已部署的 `pin-hao-mo` preset 配置快照（2026-09-20）。

默认由 DeepSeek 执行和调度；单一专业任务只委派一个模型，跨能力任务使用受限多模型工作流。

## 文件

- `agent.cordis.yml`：完整 Agent 配置、提示词、工具、模型委派和工作流约束，保持当前部署内容原样。
- `preset.yml`：名称、描述与排序。
- `skills/`：9 个当前技能及研发工作流参考文档。
- `_retired-skills/`：原部署目录保留的历史技能，不在当前 `skills/` 加载目录中。
- `host/settings.yaml`：模型提供商、6 个模型、默认模型与默认 preset；不包含 onboarding 状态。
- `host/profile-web/`：宿主 profile 入口、patch 和固定版本插件依赖。移除了本机专属的 generationProjection 与 pnpm link overrides，保留发布版本和 bundle 顺序。
- `snapshot.sha256`：本次配置文件的 SHA-256 校验清单。

## 恢复配置

1. 在兼容的 DSH Desktop 中，将根目录的 `agent.cordis.yml`、`preset.yml` 和 `skills/` 放入 harness 的 `.agent-presets/pin-hao-mo/`；历史技能可按需一并保存。
2. 将 `host/settings.yaml` 中的模型与 preset 配置合并到宿主 `settings.yaml`，避免覆盖其他已有设置。
3. 在目标机器本地配置 `DOUBAO_API_KEY` 或 DSH 的凭据存储。模型提供商名为 `doubao`，API 地址为 `https://ark.cn-beijing.volces.com/api/plan/v3`。
4. 宿主需提供当前 YAML 引用的 DSH 插件和 `spawn` 子 Agent 提供方。`host/profile-web/package.json` 记录原环境的附加插件版本；基础 bundle 由兼容的 DSH Desktop 提供。不要直接覆盖其他宿主 profile。
5. 图片和视频生成技能需要本机安装并登录 ArkCLI，配置可调用的图片/视频资源。仓库不携带 ArkCLI 登录凭据。
6. 重载/重启 DSH Desktop 后选择“拼好模”。

## 模型路由

| 用途 | 模型 |
| --- | --- |
| 默认执行与调度 | deepseek-v4-1-flash |
| 长上下文研究 | kimi-k2-8-preview |
| 独立质量检查 | kimi-k2.7-code |
| 静态视觉分析 | glm-5-3-flash |
| 创意内容 | minimax-m3 |
| 音视频理解 | doubao-seed-2-0-lite-260215 |

图片/视频生成由 ArkCLI 技能调用 Seedream / Seedance；详见对应技能。

## 快照范围

本仓库保存当前已部署 preset 及其宿主配置依赖，不包含实验目录中的另一套交付控制器、同名网页演示项目、会话记录、缓存、node_modules、API Key 或其他登录凭据。YAML 中的 `!!js` 是 DSH 配置表达式，需要由 DSH 加载器解析。

本次同步核对了 preset 文件逐字节一致性和配置文件校验和；没有发起付费模型调用或跨机器运行验证。
