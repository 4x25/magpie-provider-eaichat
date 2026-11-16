import { strict as assert } from "node:assert"
import { test } from "node:test"
import { MODEL_IDS } from "../src/constants.ts"
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

test("模型目录：展示名称标准化并声明 1M 上下文", () => {
  const models = modelsFor("anthropic")
  const expected = {
    "deepseek-v4.1-flash": ["DeepSeek-V4.1-Flash", 1_048_576],
    "glm-5.3-flash": ["GLM-5.3-Flash", 1_000_000],
    "deepseek-v4-flash-0731-oc": ["DeepSeek-V4-Flash", 1_048_576],
    "deepseek-v4-pro-0813-oc": ["DeepSeek-V4-Pro", 1_048_576],
    "glm-5.3-oc": ["GLM-5.3", 1_000_000],
    "qwen-3.8-flash": ["Qwen3.8-Flash", 1_000_000],
  } as const

  for (const [id, [name, context]] of Object.entries(expected)) {
    assert.equal(models[id].name, name)
    assert.equal(models[id].limit.context, context)
    assert.ok(models[id].limit.context >= 1_000_000)
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
