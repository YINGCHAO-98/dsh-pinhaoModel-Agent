# 工作流合同

## 结构化阶段结果

每个 `agent()` 调用使用同一个对象根 schema。只使用工作流引擎支持的 JSON Schema 子集。

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": ["passed", "failed", "blocked"]
    },
    "summary": { "type": "string" },
    "artifacts": {
      "type": "array",
      "items": { "type": "string" }
    },
    "evidence": {
      "type": "array",
      "items": { "type": "string" }
    },
    "issues": {
      "type": "array",
      "items": { "type": "string" }
    },
    "limitations": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": [
    "status",
    "summary",
    "artifacts",
    "evidence",
    "issues",
    "limitations"
  ],
  "additionalProperties": false
}
```

`passed` 的阶段必须有对应的产物或验证证据。测试阶段没有 evidence 时不得为 passed。

## 子 Agent 提示合同

工作流直接创建的子 Agent 可能继承父级工具，因此每个 prompt 都必须明确：

- 当前唯一角色、阶段目标和可验收结果；
- 需要加载的 Skill：产品、方案、实现与修复阶段使用 DeepSeek；实现与修复加载 `deepseek-code-execution`，
  质量阶段加载 `kimi-code-quality-gate`；
- 禁止调用 `workflow` 或任何 `task_*` 工具，禁止再委派 Agent；
- 工作区绝对路径、允许修改的范围、上游产物绝对路径和适用约束；
- 长产物必须写入的目标文件；返回值只填写 schema 要求的状态、摘要、产物、证据、问题和限制；
- 质量阶段不得修改生产实现，修复阶段不得自行宣告质量门禁通过。

不要只写“你是产品 Agent”之类的短提示。角色提示缺少输入、输出路径或验收条件时，不启动该阶段。

## 标准编排形状

工作流脚本使用 `args.objective`、`args.cwd` 和必要的用户约束。根据任务剪裁提示，不原样复制整段对话。

```js
phase("Product")
const product = await agent(productPrompt, {
  label: "Product definition",
  phase: "Product",
  provider: "doubao",
  model: "deepseek-v4-1-flash",
  schema: stageSchema,
})
if (!product || product.status !== "passed") {
  return { status: "blocked", stage: "product", result: product }
}

phase("Design")
const design = await agent(designPrompt(product), {
  label: "Technical design",
  phase: "Design",
  provider: "doubao",
  model: "deepseek-v4-1-flash",
  schema: stageSchema,
})
if (!design || design.status !== "passed") {
  return { status: "blocked", stage: "design", result: design }
}

phase("Build")
let implementation = await agent(buildPrompt(product, design), {
  label: "Implementation",
  phase: "Build",
  provider: "doubao",
  model: "deepseek-v4-1-flash",
  schema: stageSchema,
})
if (!implementation || implementation.status !== "passed") {
  return { status: "failed", stage: "build", result: implementation }
}

phase("Quality")
let quality = await agent(testPrompt(product, design, implementation), {
  label: "Independent quality gate",
  phase: "Quality",
  provider: "doubao",
  model: "kimi-k2.7-code",
  schema: stageSchema,
})

for (let attempt = 1; quality && quality.status === "failed" && attempt <= 2; attempt++) {
  phase("Repair")
  implementation = await agent(repairPrompt(quality), {
    label: `Targeted repair ${attempt}`,
    phase: "Repair",
    provider: "doubao",
    model: "deepseek-v4-1-flash",
    schema: stageSchema,
  })
  if (!implementation || implementation.status !== "passed") break

  phase("Quality")
  quality = await agent(retestPrompt(quality, implementation), {
    label: `Quality gate ${attempt + 1}`,
    phase: "Quality",
    provider: "doubao",
    model: "kimi-k2.7-code",
    schema: stageSchema,
  })
}

return {
  status: quality && quality.status === "passed" ? "passed" : "failed",
  product,
  design,
  implementation,
  quality,
}
```

不照抄上述未定义的 helper；实际脚本必须提供完整的 `stageSchema` 和 prompt 字符串。跨模态发现任务若相互独立，可在产品阶段用 `parallel()` 同时运行；
必须汇总全部结果时才引入屏障。
