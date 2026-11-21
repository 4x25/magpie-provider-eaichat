import { strict as assert } from "node:assert"
import { test } from "node:test"
import { MODEL_IDS } from "../src/constants.ts"
import { MODEL_METADATA } from "../src/model-metadata.ts"
import { modelsFor } from "../src/models.ts"

const ANTHROPIC_URL = "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1"
const OPENAI_URL = "https://eaichat.ctyun.cn/ai/platform/v2/cp"

test("内置回退清单：id 与上游一致，清单为空时使用", () => {
  const models = modelsFor("anthropic")
  assert.deepEqual(Object.keys(models), MODEL_IDS.map((m) => m.id))
  assert.deepEqual(Object.keys(modelsFor("anthropic", [])), MODEL_IDS.map((m) => m.id))
  for (const m of MODEL_IDS) {
    assert.equal(models[m.id].api.id, m.id)
    assert.equal(models[m.id].name, m.name)
  }
})

test("上游清单：id 与展示名来自上游，并沿用 models.dev 元数据", () => {
  const models = modelsFor("openai", [
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash-1017", apis: [] },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", apis: [] },
  ])
  assert.deepEqual(Object.keys(models), ["deepseek-v4.1-flash", "glm-5.3-flash"])
  assert.equal(models["deepseek-v4.1-flash"].name, "DeepSeek-V4.1-Flash-1017")
  assert.equal(models["glm-5.3-flash"].name, "GLM-5.3-Flash")
  assert.equal(models["deepseek-v4.1-flash"].limit.context, 1_048_576)
  assert.deepEqual(models["glm-5.3-flash"].modalities.input, ["text", "image", "video"])
})

test("上游清单：未映射的新模型退化为保守默认值", () => {
  const models = modelsFor("anthropic", [
    { id: "future-model", name: "Future Model", apis: [] },
  ])
  const model = models["future-model"]
  assert.equal(model.name, "Future Model")
  assert.equal(model.limit.context, 128_000)
  assert.equal(model.limit.output, 32_000)
  assert.deepEqual(model.modalities.input, ["text"])
  assert.equal(model.reasoning, false)
  assert.equal(model.capabilities.reasoning, false)
  assert.equal(model.api.npm, "@ai-sdk/anthropic")
  assert.equal(model.api.url, ANTHROPIC_URL)
  assert.equal(model.api.id, "future-model")
  assert.equal(model.variants, undefined)
})

test("上游清单：按 api 字段过滤协议，未声明时两种都可用", () => {
  const list = [
    { id: "both", name: "Both", apis: ["openai-completions", "anthropic-messages"] },
    { id: "openai-only", name: "OpenAI Only", apis: ["openai-completions"] },
    { id: "anthropic-only", name: "Anthropic Only", apis: ["anthropic-messages"] },
    { id: "undeclared", name: "Undeclared", apis: [] },
  ]
  assert.deepEqual(Object.keys(modelsFor("openai", list)), ["both", "openai-only", "undeclared"])
  assert.deepEqual(Object.keys(modelsFor("anthropic", list)), ["both", "anthropic-only", "undeclared"])
})

test("模型目录：上下文/输出/多模态来自 models.dev 生成的元数据", () => {
  const models = modelsFor("anthropic")
  const expected = {
    "deepseek-v4.1-flash": {
      context: 1_048_576,
      output: 384_000,
      input: ["text", "image"],
      efforts: ["none", "low", "high", "max"],
    },
    "glm-5.3-flash": {
      context: 1_000_000,
      output: 131_072,
      input: ["text", "image", "video"],
      efforts: ["low", "high", "max"],
    },
    "deepseek-v4-pro-0813-oc": {
      context: 1_000_000,
      output: 384_000,
      input: ["text"],
      efforts: ["none", "low", "high", "max"],
    },
    "glm-5.3-oc": {
      context: 1_000_000,
      output: 131_072,
      input: ["text"],
      efforts: ["low", "high", "max"],
    },
    "qwen-3.8-flash": {
      context: 1_000_000,
      output: 131_072,
      input: ["text", "image", "video"],
      efforts: ["none", "low", "medium", "xhigh"],
    },
  } as const

  for (const [id, want] of Object.entries(expected)) {
    const model = models[id]
    assert.equal(model.limit.context, want.context, `${id} context`)
    assert.equal(model.limit.output, want.output, `${id} output`)
    assert.deepEqual(model.modalities.input, want.input, `${id} modalities`)
    assert.equal(model.reasoning, true, `${id} reasoning`)
    assert.equal(model.capabilities.reasoning, true, `${id} capabilities.reasoning`)
    assert.equal(model.capabilities.toolcall, true, `${id} capabilities.toolcall`)
    assert.equal(
      model.capabilities.attachment,
      want.input.some((kind) => kind !== "text"),
      `${id} attachment`,
    )
    for (const kind of ["text", "image", "audio", "video", "pdf"] as const) {
      assert.equal(
        model.capabilities.input[kind],
        (want.input as readonly string[]).includes(kind),
        `${id} capabilities.input.${kind}`,
      )
    }
    assert.deepEqual(
      Object.keys(model.variants ?? {}),
      want.efforts,
      `${id} variants`,
    )
    for (const effort of want.efforts) {
      assert.deepEqual(model.variants?.[effort], { reasoningEffort: effort })
    }
  }
})

test("模型元数据：每个回退模型都来自 models.dev 且有聚合条目", () => {
  for (const model of MODEL_IDS) {
    const meta = MODEL_METADATA[model.canonical]
    assert.ok(meta, `${model.canonical} missing`)
    assert.ok(meta.context > 0, `${model.canonical} context`)
    assert.ok(meta.output > 0, `${model.canonical} output`)
    assert.ok(meta.input.includes("text"), `${model.canonical} text input`)
    assert.ok(meta.sourceEntries > 0, `${model.canonical} sourceEntries`)
  }
})

test("anthropic 协议：npm 与 url", () => {
  const models = modelsFor("anthropic")
  const glm = models["glm-5.3-oc"]
  assert.equal(glm.api.npm, "@ai-sdk/anthropic")
  assert.equal(glm.api.url, ANTHROPIC_URL)
  assert.equal(glm.reasoning, true)
  assert.equal(glm.tool_call, true)
  assert.deepEqual(glm.modalities.input, ["text"])
  assert.ok(glm.limit.context > 0)
  assert.ok(glm.limit.output > 0)
})

test("openai 协议：npm 与 url", () => {
  const models = modelsFor("openai")
  const ds = models["deepseek-v4.1-flash"]
  assert.equal(ds.api.npm, "@ai-sdk/openai-compatible")
  assert.equal(ds.api.url, OPENAI_URL)
})
