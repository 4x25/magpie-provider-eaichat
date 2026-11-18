import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mapUpstreamUrl, relayFetch } from "../src/relay.ts"

test("Anthropic 路径归一：/messages → /v1/messages", () => {
  assert.equal(
    mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/messages"),
    "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages",
  )
  // 已经带 /v1 的不重复加
  assert.equal(
    mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages"),
    "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages",
  )
})

test("OpenAI 路径：/chat/completions 原样（含查询串）", () => {
  assert.equal(
    mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions"),
    "https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions",
  )
})

test("协议切换后缓存 baseURL 的兼容归一", () => {
  // loader baseURL 残留 anthropic base，但模型已切到 OpenAI 协议
  assert.equal(
    mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/chat/completions"),
    "https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions",
  )
  // loader baseURL 残留 openai base，但模型走 Anthropic 协议
  assert.equal(
    mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/v1/messages"),
    "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages",
  )
})

test("count_tokens 归一", () => {
  assert.equal(
    mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/count_tokens"),
    "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/count_tokens",
  )
})

test("relayFetch：透传方法/头/体并改写 URL（SSE 流式原样）", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response('data: {"delta":"hi"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  }) as typeof fetch
  try {
    const res = await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-1", "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3-oc", stream: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("content-type"), "text/event-stream")
    assert.equal(await res.text(), 'data: {"delta":"hi"}\n\n')
    assert.equal(calls.length, 1)
    assert.equal(
      calls[0].url,
      "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages",
    )
    assert.equal(calls[0].init?.method, "POST")
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：apiKey 时把 x-api-key 改写为 Authorization: Bearer", async () => {
  const seen: Array<Headers> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    await relayFetch(
      "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages",
      {
        method: "POST",
        headers: { "x-api-key": "sk-old", "anthropic-version": "2023-06-01" },
        body: "{}",
      },
      { apiKey: "sk-real" },
    )
    const h = seen[0]
    assert.equal(h.get("authorization"), "Bearer sk-real")
    assert.equal(h.get("x-api-key"), null) // 上游不认 x-api-key，必须去掉
    assert.equal(h.get("anthropic-version"), "2023-06-01") // 其余头透传

    // 无 apiKey 时不动头
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-old" },
      body: "{}",
    })
    assert.equal(seen[1].get("authorization"), "Bearer sk-old")
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：上游错误状态与正文原样返回", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
  try {
    const res = await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions", {
      method: "POST",
      body: "{}",
    })
    assert.equal(res.status, 401)
    assert.match(await res.text(), /invalid api key/)
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：OpenAI 档位写入 enable_thinking + reasoning_effort", async () => {
  const calls: Array<{ headers: Headers; body: string }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ headers: new Headers(init?.headers), body: String(init?.body ?? "") })
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions", {
      method: "POST",
      headers: new Headers({
        "x-magpie-effort": "high",
        "content-length": "999",
        "content-type": "application/json",
      }),
      body: JSON.stringify({ model: "glm-5.3-oc", messages: [] }),
    })
    const body = JSON.parse(calls[0].body)
    assert.equal(body.enable_thinking, true)
    assert.equal(body.reasoning_effort, "high")
    assert.equal(calls[0].headers.get("x-magpie-effort"), null)
    assert.equal(calls[0].headers.get("content-length"), null)
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：OpenAI none 关掉思考", async () => {
  let captured: Record<string, unknown> = {}
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}"))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions", {
      method: "POST",
      headers: { "x-magpie-effort": "none" },
      body: JSON.stringify({ model: "qwen-3.8-flash", messages: [] }),
    })
    assert.equal(captured.enable_thinking, false)
    assert.equal(captured.reasoning_effort, "none")
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：Anthropic 档位写入 thinking 预算与 output_config", async () => {
  let captured: Record<string, unknown> = {}
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}"))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash", max_tokens: 4096, messages: [] }),
    })
    assert.deepEqual(captured.thinking, { type: "enabled", budget_tokens: 24_000 })
    assert.deepEqual(captured.output_config, { effort: "high" })
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：Anthropic none 关掉思考并保留 output_config 的其他字段", async () => {
  let captured: Record<string, unknown> = {}
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}"))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-magpie-effort": "none" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        thinking: { type: "enabled", budget_tokens: 123 },
        output_config: { effort: "low", format: { type: "json" } },
        messages: [],
      }),
    })
    assert.deepEqual(captured.thinking, { type: "disabled" })
    assert.deepEqual(captured.output_config, { format: { type: "json" } })
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：没有档位头时请求体原样不动", async () => {
  let received = ""
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    received = String(init?.body ?? "")
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    const body = JSON.stringify({
      model: "glm-5.3-oc",
      reasoning_effort: "max",
      thinking: { type: "enabled", budget_tokens: 1 },
    })
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions", {
      method: "POST",
      headers: { "x-magpie-effort": "" },
      body,
    })
    assert.equal(received, body)
  } finally {
    globalThis.fetch = original
  }
})

test("relayFetch：count_tokens 不写档位，但去掉 magpie 专用头", async () => {
  let received = ""
  let headers = new Headers()
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    received = String(init?.body ?? "")
    headers = new Headers(init?.headers)
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  try {
    const body = JSON.stringify({ model: "glm-5.3-oc", messages: [] })
    await relayFetch("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/count_tokens", {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body,
    })
    assert.equal(received, body)
    assert.equal(headers.get("x-magpie-effort"), null)
  } finally {
    globalThis.fetch = original
  }
})
