import { strict as assert } from "node:assert"
import { test } from "node:test"
import { MODEL_IDS } from "../src/constants.ts"
import { MODEL_METADATA } from "../src/model-metadata.ts"
import { modelsFor } from "../src/models.ts"

const ANTHROPIC_URL = "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1"
const OPENAI_URL = "https://eaichat.ctyun.cn/ai/platform/v2/cp"

test("模型目录：6 个模型，id 与上游一致", () => {
  const models = modelsFor("anthropic")
  assert.deepEqual(Object.keys(models), MODEL_IDS.map((m) => m.id))
  for (const m of MODEL_IDS) {
    assert.equal(models[m.id].api.id, m.id)
    assert.equal(models[m.id].name, m.name)
  }
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
    "deepseek-v4-flash-0731-oc": {
      context: 1_048_576,
      output: 384_000,
      input: ["text"],
      efforts: ["none", "low", "high", "max"],
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

test("模型元数据：每个规范模型都来自 models.dev 且有聚合条目", () => {
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
