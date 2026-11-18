/**
 * 模型请求转发：URL 归一（兼容缓存中的 loader baseURL 与协议切换）+ 认证头修正 + 原样透传。
 *
 * 实测（2026-11-12）：两个上游端点都只认 `Authorization: Bearer <apiKey>`，
 * Anthropic 端点不认 `x-api-key`（401），因此这里统一改写认证头。
 *   - Anthropic Messages: https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages
 *   - OpenAI Chat:        https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions
 *
 * 思考档位：magpie 把用户选的档位放在 `X-Magpie-Effort`，插件据此改写请求体：
 *   - OpenAI：enable_thinking + reasoning_effort（上游合法值 none/minimal/low/medium/high/xhigh/max/ultra）
 *   - Anthropic：thinking.budget_tokens + output_config.effort
 * 没有该头时请求体一个字节都不动。
 */
import { ANTHROPIC_BASE, OPENAI_BASE } from "./constants.ts"

/** magpie 传给插件 fetch 的档位头（不会发给上游）。 */
const EFFORT_HEADER = "x-magpie-effort"

/** Anthropic thinking 预算；与 magpie 的 budgetOf 对齐，max 取 32K。 */
const EFFORT_BUDGETS: Record<string, number> = {
  minimal: 1_024,
  low: 4_096,
  medium: 10_000,
  high: 24_000,
  xhigh: 32_000,
  max: 32_000,
  ultra: 32_000,
}

/** 网关侧 URL → 上游真实 URL。 */
export function mapUpstreamUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    if (u.pathname.endsWith("/chat/completions")) {
      return `${OPENAI_BASE}/chat/completions${u.search}`
    }
    if (u.pathname.endsWith("/messages")) {
      return `${ANTHROPIC_BASE}/v1/messages${u.search}`
    }
    if (u.pathname.endsWith("/count_tokens")) {
      return `${ANTHROPIC_BASE}/v1/count_tokens${u.search}`
    }
    return rawUrl
  } catch {
    return rawUrl
  }
}

export interface RelayOptions {
  /** 账号的 API Key：给出时统一改写为 Authorization: Bearer。 */
  apiKey?: string
}

function headerOf(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string {
  const h = init?.headers
  if (h) {
    if (h instanceof Headers) {
      const value = h.get(name)
      if (value) return value
    } else if (Array.isArray(h)) {
      for (const [key, value] of h) if (key.toLowerCase() === name) return String(value)
    } else if (typeof h === "object") {
      for (const [key, value] of Object.entries(h)) {
        if (key.toLowerCase() === name) return String(value)
      }
    }
  }
  if (typeof input !== "string" && !(input instanceof URL) && input.headers) {
    return input.headers.get(name) ?? ""
  }
  return ""
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function bodyText(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  return null
}

function protocolOf(url: string): "openai" | "anthropic" | "" {
  try {
    const path = new URL(url).pathname
    if (path.endsWith("/chat/completions")) return "openai"
    if (path.endsWith("/messages")) return "anthropic"
  } catch {
    /* 非绝对 URL：不处理 */
  }
  return ""
}

/** 把 magpie 的档位写进请求体；返回新 body，无法识别时返回 null。 */
function withEffort(url: string, body: string, effort: string): string | null {
  const protocol = protocolOf(url)
  if (!protocol) return null
  const record = parseRecord(body)
  if (!record) return null

  const off = effort === "none" || effort === "off"
  if (protocol === "openai") {
    record.enable_thinking = !off
    record.reasoning_effort = off ? "none" : effort
    return JSON.stringify(record)
  }

  if (off) {
    record.thinking = { type: "disabled" }
    const output = record.output_config
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const next = { ...(output as Record<string, unknown>) }
      delete next.effort
      if (Object.keys(next).length > 0) record.output_config = next
      else delete record.output_config
    }
    return JSON.stringify(record)
  }

  record.thinking = {
    type: "enabled",
    budget_tokens: EFFORT_BUDGETS[effort] ?? EFFORT_BUDGETS.high,
  }
  const output = record.output_config
  record.output_config = {
    ...(output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : {}),
    effort,
  }
  return JSON.stringify(record)
}

/** 转发 fetch：改 URL、修正认证头、按档位改请求体，透传方法/头/体/取消信号，流式响应原样返回。 */
export async function relayFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RelayOptions = {},
): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = mapUpstreamUrl(rawUrl)
  const effort = headerOf(input, init, EFFORT_HEADER).trim().toLowerCase()

  let body = init?.body
  let bodyChanged = false
  if (effort) {
    const text = bodyText(body)
    if (text !== null) {
      const next = withEffort(url, text, effort)
      if (next !== null && next !== text) {
        body = next
        bodyChanged = true
      }
    }
  }

  let headers: Headers | undefined
  if (options.apiKey || effort || bodyChanged) {
    headers = new Headers(init?.headers)
    if (options.apiKey) {
      headers.delete("x-api-key")
      headers.set("authorization", `Bearer ${options.apiKey}`)
    }
    if (effort) headers.delete(EFFORT_HEADER)
    if (bodyChanged) headers.delete("content-length")
  }

  const merged: RequestInit | undefined = bodyChanged
    ? { ...init, body, headers }
    : headers
      ? { ...init, headers }
      : init

  if (typeof input !== "string" && !(input instanceof URL)) {
    if (url !== rawUrl || merged) {
      return fetch(new Request(url, input), merged)
    }
    return fetch(input, init)
  }
  return fetch(url, merged)
}
