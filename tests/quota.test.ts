import { strict as assert } from "node:assert"
import { test } from "node:test"
import { quotaTextState } from "../src/quota.ts"
import { relayFetch } from "../src/relay.ts"

const OPENAI_URL = "https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions"
const ANTHROPIC_URL = "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages"

/** 2026-11-20 实测的上游充值文案。 */
const QUOTA_PROMPT =
  "您的Token额度已用完！\n" +
  "如需继续使用，可前往订购页面选择合适Token套餐。\n" +
  "购买后，请新建会话，解锁AI完整体验。\n" +
  "购买Token方式如下：\n" +
  "1）云电脑云智助手Token点击购买：<https://desk.ctyun.cn/selforder/#/avt/tokens>\n" +
  "2）息壤Token点击购买：<https://www.ctyun.cn/products/maas>\n" +
  "说明：购买息壤Token，需要进行配置，配置指引：<https://www.ctyun.cn/document/10027004/11092372#section-0aa1b3ee5c24665f>\n" +
  " （ccda8e4b-705d-4b1f-9af5-8724448e87f3）"

function withFetch(response: Response | (() => Response)): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => (typeof response === "function" ? response() : response)) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" },
  })
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream;charset=UTF-8" },
  })
}

function openaiPromptBody(model = "ctyun-smart-oc"): Record<string, unknown> {
  return {
    model,
    id: "",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: QUOTA_PROMPT }, finish_reason: "stop" }],
  }
}

function anthropicPromptBody(model = "ctyun-smart-claude"): Record<string, unknown> {
  return {
    id: "",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: QUOTA_PROMPT }],
    stop_reason: "refusal",
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

test("quotaTextState：前缀 / 命中 / 偏离", () => {
  assert.equal(quotaTextState(""), "maybe")
  assert.equal(quotaTextState("您"), "maybe")
  assert.equal(quotaTextState("您的Token额度已用完"), "maybe")
  assert.equal(quotaTextState("您的Token额度已用完！"), "maybe")
  assert.equal(quotaTextState("您的Token额度已用完！\n如需继续使用，可前往订购页面选择合适Token套餐"), "yes")
  assert.equal(quotaTextState(QUOTA_PROMPT), "yes")
  // 模型只是复述开头，后面不是充值说明
  assert.equal(quotaTextState("您的Token额度已用完！这句话是什么意思？"), "no")
  // 普通回复
  assert.equal(quotaTextState("收到"), "no")
})

test("OpenAI 非流式：充值文案 → 402 insufficient_quota", async () => {
  const restore = withFetch(jsonResponse(openaiPromptBody()))
  try {
    const res = await relayFetch(OPENAI_URL, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [] }),
    })
    assert.equal(res.status, 402)
    assert.match(res.headers.get("content-type") ?? "", /application\/json/)
    const body = (await res.json()) as { error?: { type?: string; code?: string; message?: string } }
    assert.equal(body.error?.type, "insufficient_quota")
    assert.equal(body.error?.code, "insufficient_quota")
    assert.match(body.error?.message ?? "", /您的Token额度已用完/)
  } finally {
    restore()
  }
})

test("Anthropic 非流式：充值文案 → 402 invalid_request_error", async () => {
  const restore = withFetch(jsonResponse(anthropicPromptBody()))
  try {
    const res = await relayFetch(ANTHROPIC_URL, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4.1-flash", max_tokens: 16, messages: [] }),
    })
    assert.equal(res.status, 402)
    const body = (await res.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }
    assert.equal(body.type, "error")
    assert.equal(body.error?.type, "invalid_request_error")
    assert.match(body.error?.message ?? "", /您的Token额度已用完/)
  } finally {
    restore()
  }
})

test("合成模型名即使正文被改写也按额度耗尽处理", async () => {
  const body = openaiPromptBody()
  const choices = body.choices as Array<{ message: { content: string } }>
  choices[0].message.content = "something else"
  const restore = withFetch(jsonResponse(body))
  try {
    const res = await relayFetch(OPENAI_URL, { method: "POST", body: "{}" })
    assert.equal(res.status, 402)
  } finally {
    restore()
  }
})

test("正常非流式响应原样返回（含只复述开头的回复）", async () => {
  for (const content of ["收到", "您的Token额度已用完！这句话是什么意思？"]) {
    const restore = withFetch(
      jsonResponse({
        model: "deepseek-v4.1-flash",
        id: "abc",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      }),
    )
    try {
      const res = await relayFetch(OPENAI_URL, { method: "POST", body: "{}" })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      assert.equal(body.choices[0].message.content, content)
    } finally {
      restore()
    }
  }
})

test("OpenAI 流式：充值文案 → 402（不是 200 SSE）", async () => {
  const chunk = `data:${JSON.stringify({
    code: 0,
    id: "",
    choices: [{ index: 0, delta: { content: QUOTA_PROMPT } }],
    created: 1795147118,
    model: "ctyun-smart-oc",
    object: "chat.completion.chunk",
  })}\n\n`
  const restore = withFetch(sseResponse([chunk]))
  try {
    const res = await relayFetch(OPENAI_URL, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [] }),
    })
    assert.equal(res.status, 402)
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /event-stream/)
    const body = (await res.json()) as { error?: { type?: string } }
    assert.equal(body.error?.type, "insufficient_quota")
  } finally {
    restore()
  }
})

test("Anthropic 流式：充值文案 → 402", async () => {
  const events = [
    `event:message_start\ndata:${JSON.stringify({
      type: "message_start",
      message: {
        type: "message",
        id: "",
        role: "assistant",
        model: "ctyun-smart-claude",
        content: [],
        usage: { input_tokens: 6, output_tokens: 1 },
      },
    })}\n\n`,
    `event:content_block_delta\ndata:${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: QUOTA_PROMPT },
    })}\n\n`,
  ]
  const restore = withFetch(sseResponse(events))
  try {
    const res = await relayFetch(ANTHROPIC_URL, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [] }),
    })
    assert.equal(res.status, 402)
    const body = (await res.json()) as { error?: { type?: string } }
    assert.equal(body.error?.type, "invalid_request_error")
  } finally {
    restore()
  }
})

test("流式文案被拆到多个 chunk 也能识别", async () => {
  const part1 = QUOTA_PROMPT.slice(0, 8)
  const part2 = QUOTA_PROMPT.slice(8, 40)
  const part3 = QUOTA_PROMPT.slice(40)
  const chunks = [part1, part2, part3].map(
    (text) =>
      `data:${JSON.stringify({
        model: "deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { content: text } }],
      })}\n\n`,
  )
  const restore = withFetch(sseResponse(chunks))
  try {
    const res = await relayFetch(OPENAI_URL, { method: "POST", body: "{}" })
    assert.equal(res.status, 402)
  } finally {
    restore()
  }
})

test("正常流式响应原样返回（body 完整）", async () => {
  const raw =
    `data:${JSON.stringify({
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
    })}\n\n` +
    `data:${JSON.stringify({
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: { content: "收到" } }],
    })}\n\n` +
    "data:[DONE]\n\n"
  const restore = withFetch(sseResponse([raw.slice(0, 70), raw.slice(70)]))
  try {
    const res = await relayFetch(OPENAI_URL, { method: "POST", body: "{}" })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-type"), "text/event-stream;charset=UTF-8")
    assert.equal(await res.text(), raw)
  } finally {
    restore()
  }
})

test("思考流不误判，且原样返回", async () => {
  const raw =
    `data:${JSON.stringify({
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: { reasoning_content: "我先想想" } }],
    })}\n\n` +
    `data:${JSON.stringify({
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, delta: { content: "收到" } }],
    })}\n\n`
  const restore = withFetch(sseResponse([raw]))
  try {
    const res = await relayFetch(OPENAI_URL, { method: "POST", body: "{}" })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), raw)
  } finally {
    restore()
  }
})

test("只有合成模型名、没有正文时也按额度耗尽处理", async () => {
  const events = [
    `event:message_start\ndata:${JSON.stringify({
      type: "message_start",
      message: {
        type: "message",
        id: "",
        role: "assistant",
        model: "ctyun-smart-claude",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })}\n\n`,
    `event:message_stop\ndata:{"type":"message_stop"}\n\n`,
  ]
  const restore = withFetch(sseResponse(events))
  try {
    const res = await relayFetch(ANTHROPIC_URL, { method: "POST", body: "{}" })
    assert.equal(res.status, 402)
    const body = (await res.json()) as { error?: { message?: string } }
    assert.match(body.error?.message ?? "", /desk\.ctyun\.cn\/selforder/)
  } finally {
    restore()
  }
})

test("Request 输入也走额度识别", async () => {
  const restore = withFetch(jsonResponse(openaiPromptBody()))
  try {
    const req = new Request(OPENAI_URL, { method: "POST", body: "{}" })
    const res = await relayFetch(req)
    assert.equal(res.status, 402)
    const body = (await res.json()) as { error?: { type?: string } }
    assert.equal(body.error?.type, "insufficient_quota")
  } finally {
    restore()
  }
})

test("上游非 200 错误原样返回", async () => {
  const body = JSON.stringify({ error: { message: "invalid api key" } })
  const restore = withFetch(
    new Response(body, { status: 401, headers: { "content-type": "application/json" } }),
  )
  try {
    const res = await relayFetch(OPENAI_URL, { method: "POST", body: "{}" })
    assert.equal(res.status, 401)
    assert.equal(await res.text(), body)
  } finally {
    restore()
  }
})
