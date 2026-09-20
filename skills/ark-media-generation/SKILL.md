---
name: ark-media-generation
description: 通过 ArkCLI 和 Agent Plan 的真实生成 API 调用 Seedream 5.0 Pro 生成/编辑图片，或调用 Seedance 2.5 生成视频。不使用 OpenAI Chat Completions 伪装成生成接口。
---

# Ark 图片与视频生成

这是真实生成流程，不是文本子 Agent。只在用户明确要求生成或编辑图片/视频时使用。

## 资源与模型

- 图片：`doubao-seedream-5.0-pro`
- 视频：`doubao-seedance-2.5`

必须按顺序执行：

1. 用 `arkcli resources list --modality image|video --format json` 确认当前 Agent Plan 可调用。
2. 用 `arkcli models get <model> --transform supported_params` 查询参数；只传递明确支持且值在允许范围内的参数。
3. 图片调用 `arkcli +gen --model doubao-seedream-5.0-pro --modality image --save-to <workspace-dir> --no-open "<prompt>"`。
4. 视频调用 `arkcli +gen --model doubao-seedance-2.5 --modality video --save-to <workspace-dir> --no-open "<prompt>"`；记录唯一 `task_id`，只轮询该任务，不重复提交。
5. 成功时以 `local_path` 为交付物；检查文件存在、格式、尺寸/时长和可解码性。

所有 ArkCLI 命令都使用完整归因前缀：

```bash
ARKCLI_NO_UPDATE_NOTIFIER=1 \
ARKCLI_CALLER_TYPE=ai_agent \
ARKCLI_CALLER_NAME=deepseek-harness \
ARKCLI_SKILL_NAME=arkcli-gen \
arkcli ...
```

## 输入和失败边界

- 只使用用户当前任务提供或明确授权复用的参考素材；本地参考文件用 `--input @<absolute-path>`。
- 不创建额外的“试验图/试验视频”来探测 Key；第一个真实交付任务同时承担可用性检查。
- 401/403/额度不足/内容审核失败后停止，不轮换 Key、不换收费通道、不重复提交。
- 视频的 `queued`/`running` 不是失败；只有 `failed`/`cancelled` 或查询本身失败才停止并报告。
- 如果视觉语义验收需要专业理解，将已生成资产交给 GLM（静态图）或豆包 Seed 2.0 Lite（视频/音频）；不调回生成模型进行自评。
