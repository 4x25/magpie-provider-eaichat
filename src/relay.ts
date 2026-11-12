/**
 * 模型请求转发：URL 归一（兼容缓存中的 loader baseURL 与协议切换）+ 认证头修正 + 原样透传。
 *
 * 实测（2026-11-12）：两个上游端点都只认 `Authorization: Bearer <apiKey>`，
 * Anthropic 端点不认 `x-api-key`（401），因此这里统一改写认证头。
 *   - Anthropic Messages: https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages
 *   - OpenAI Chat:        https://eaichat.ctyun.cn/ai/platform/v2/cp/chat/completions
 */
import { ANTHROPIC_BASE, OPENAI_BASE } from "./constants.ts"

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

/** 转发 fetch：改 URL、修正认证头、透传方法/头/体/取消信号，流式响应原样返回。 */
export async function relayFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RelayOptions = {},
): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = mapUpstreamUrl(rawUrl)

  let headers: Headers | undefined
  if (options.apiKey) {
    headers = new Headers(init?.headers)
    headers.delete("x-api-key")
    headers.set("authorization", `Bearer ${options.apiKey}`)
  }

  const merged: RequestInit | undefined = headers ? { ...init, headers } : init

  if (typeof input !== "string" && !(input instanceof URL)) {
    if (url !== rawUrl || headers) {
      return fetch(new Request(url, input), merged)
    }
    return fetch(input, init)
  }
  return fetch(url, merged)
}
