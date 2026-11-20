/**
 * 额度耗尽识别：上游在 Token 余额为 0 时仍返回 HTTP 200，把充值文案
 * 塞进正常回复（OpenAI: choices[].message.content，Anthropic: content[].text，
 * 流式则在 delta 里）。这里把它还原成协议兼容的错误响应，避免客户端把
 * 充值文案当成模型输出。
 */
import { isRecord, type JsonRecord } from "./util.ts"

export type QuotaProtocol = "openai" | "anthropic"

/** 上游额度耗尽时固定使用的合成模型名。 */
const QUOTA_MODEL_PREFIX = "ctyun-smart-"

/** 充值文案的固定开头与第二句（用于区分模型自己复述这句话）。 */
const QUOTA_HEAD = "您的Token额度已用完！"
const QUOTA_DETAIL = "如需继续使用，可前往订购页面选择合适Token套餐"

const DEFAULT_QUOTA_MESSAGE =
  "您的Token额度已用完！如需继续使用，请前往 https://desk.ctyun.cn/selforder/#/avt/tokens 购买 Token 套餐。"

/** 单次流式检查最多读这么多字节；充值文案只有几百字节。 */
const MAX_PEEK_BYTES = 256 * 1024

/** 非流式 JSON 超过这个大小就不可能是充值文案，直接放行。 */
const MAX_JSON_BYTES = 64 * 1024

export function isQuotaModel(model: unknown): boolean {
  return (
    typeof model === "string" && model.trim().toLowerCase().startsWith(QUOTA_MODEL_PREFIX)
  )
}

/**
 * 判断一段文本离充值文案有多远：
 * - no：已经确定不是（开头不符，或开头之后偏离了第二句）；
 * - maybe：还是文案前缀，继续等后续 chunk；
 * - yes：命中完整特征。
 */
export function quotaTextState(raw: string): "no" | "maybe" | "yes" {
  const text = raw.trimStart()
  if (!text) return "maybe"
  if (!text.startsWith(QUOTA_HEAD)) {
    return QUOTA_HEAD.startsWith(text) ? "maybe" : "no"
  }
  const rest = text.slice(QUOTA_HEAD.length).replace(/^\s+/, "")
  if (!rest) return "maybe"
  if (rest.startsWith(QUOTA_DETAIL)) return "yes"
  if (QUOTA_DETAIL.startsWith(rest)) return "maybe"
  return "no"
}

export function quotaMessageOf(raw: string): string {
  const text = raw.trim()
  return text ? text.slice(0, 2000) : DEFAULT_QUOTA_MESSAGE
}

/** 402：额度耗尽重试无用；不用 429，避免 OpenAI/Anthropic SDK 自动重试。 */
export function quotaErrorResponse(protocol: QuotaProtocol, raw: string): Response {
  const message = quotaMessageOf(raw)
  const body =
    protocol === "anthropic"
      ? { type: "error", error: { type: "invalid_request_error", message } }
      : {
          error: {
            message,
            type: "insufficient_quota",
            param: null,
            code: "insufficient_quota",
          },
        }
  return new Response(JSON.stringify(body), {
    status: 402,
    statusText: "Payment Required",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-eaichat-error": "quota_exhausted",
    },
  })
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const part of content) {
    if (typeof part === "string") out += part
    else if (isRecord(part) && typeof part.text === "string") out += part.text
  }
  return out
}

/** 从非流式 JSON 中取出模型回复正文（OpenAI message.content / Anthropic content）。 */
export function contentTextOf(protocol: QuotaProtocol, json: JsonRecord): string {
  if (protocol === "anthropic") {
    if (!Array.isArray(json.content)) return ""
    let out = ""
    for (const part of json.content) {
      // 只看 text 块，避免把 thinking 里复述的文案当成回复
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        out += part.text
      }
    }
    return out
  }
  const choices = json.choices
  if (!Array.isArray(choices)) return ""
  let out = ""
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue
    out += textOfContent(choice.message.content)
  }
  return out
}

/** 非流式响应的模型名（Anthropic 兼容 message_start 形状）。 */
function modelOf(protocol: QuotaProtocol, json: JsonRecord): unknown {
  if (protocol === "anthropic" && isRecord(json.message)) return json.message.model
  return json.model
}

interface SseEvent {
  event: string
  data: string
}

/** 增量 SSE 解析：只关心 data 行，容忍 \r\n 与 chunk 边界。 */
class SseParser {
  private buffer = ""

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const out: SseEvent[] = []
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (!match) break
      const raw = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const event = parseSseEvent(raw)
      if (event) out.push(event)
    }
    return out
  }

  flush(): SseEvent[] {
    const raw = this.buffer
    this.buffer = ""
    const event = parseSseEvent(raw)
    return event ? [event] : []
  }
}

function parseSseEvent(raw: string): SseEvent | null {
  let event = ""
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null
}

interface StreamState {
  synthetic: boolean
  text: string
}

type StreamVerdict = "no" | "maybe" | "quota"

function processStreamEvent(
  protocol: QuotaProtocol,
  event: SseEvent,
  state: StreamState,
): StreamVerdict {
  let json: unknown
  try {
    json = JSON.parse(event.data)
  } catch {
    return "maybe" // [DONE]、心跳等
  }
  if (!isRecord(json)) return "maybe"

  if (isRecord(json.error)) {
    const message = typeof json.error.message === "string" ? json.error.message : ""
    return quotaTextState(message) === "yes" ? "quota" : "no"
  }

  if (protocol === "anthropic") {
    const type = typeof json.type === "string" ? json.type : ""
    if (type === "message_start" && isRecord(json.message) && isQuotaModel(json.message.model)) {
      state.synthetic = true
    }
    if (type === "content_block_start" && isRecord(json.content_block)) {
      // thinking / tool_use 等非文本块：合成文案不会有；真实模型则直接放行
      if (json.content_block.type !== "text") return state.synthetic ? "quota" : "no"
    }
    if (type === "content_block_delta" && isRecord(json.delta)) {
      if (json.delta.type !== "text_delta") return state.synthetic ? "quota" : "no"
      if (typeof json.delta.text === "string") state.text += json.delta.text
    }
  } else {
    if (isQuotaModel(json.model)) state.synthetic = true
    const choices = json.choices
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) continue
        const delta = choice.delta
        // 有思考/工具调用就说明是真实模型输出，合成文案没有这些字段
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          return state.synthetic ? "quota" : "no"
        }
        if (delta.tool_calls) return state.synthetic ? "quota" : "no"
        if (typeof delta.content === "string") state.text += delta.content
        else if (Array.isArray(delta.content)) state.text += textOfContent(delta.content)
      }
    }
  }

  if (state.synthetic && state.text) return "quota"
  const verdict = quotaTextState(state.text)
  if (verdict === "yes") return "quota"
  if (verdict === "no") return "no"
  return "maybe"
}

async function inspectStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  protocol: QuotaProtocol,
): Promise<{ quota: boolean; text: string }> {
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const state: StreamState = { synthetic: false, text: "" }
  let bytes = 0

  const consume = (events: SseEvent[]): boolean | null => {
    for (const event of events) {
      const verdict = processStreamEvent(protocol, event, state)
      if (verdict === "quota") return true
      if (verdict === "no") return false
    }
    return null
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      const tail = decoder.decode()
      if (tail) {
        const verdict = consume(parser.push(tail))
        if (verdict !== null) return { quota: verdict, text: state.text }
      }
      const verdict = consume(parser.flush())
      if (verdict !== null) return { quota: verdict, text: state.text }
      break
    }
    bytes += value.byteLength
    if (bytes > MAX_PEEK_BYTES) return { quota: false, text: state.text }
    const verdict = consume(parser.push(decoder.decode(value, { stream: true })))
    if (verdict !== null) return { quota: verdict, text: state.text }
  }

  return { quota: state.synthetic, text: state.text }
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
}

function isJson(response: Response): boolean {
  const type = (response.headers.get("content-type") ?? "").toLowerCase()
  return type.includes("application/json") || type.includes("+json")
}

/**
 * 检查上游响应；命中充值文案时取消原响应并返回 402。
 * 非命中路径原样返回原 Response（用 clone 检查，不动原始 body/头）。
 */
export async function guardQuotaResponse(
  response: Response,
  protocol: QuotaProtocol,
): Promise<Response> {
  if (response.status !== 200) return response
  try {
    if (isEventStream(response)) {
      const clone = response.clone()
      const reader = clone.body?.getReader()
      if (!reader) return response
      let decision: { quota: boolean; text: string }
      try {
        decision = await inspectStream(reader, protocol)
      } finally {
        // 不 await：tee 的另一支还没消费时，cancel 的 Promise 可能一直挂着。
        void reader.cancel().catch(() => {})
      }
      if (!decision.quota) return response
      void response.body?.cancel().catch(() => {})
      return quotaErrorResponse(protocol, decision.text)
    }

    if (isJson(response)) {
      const length = Number(response.headers.get("content-length") ?? "0")
      if (Number.isFinite(length) && length > MAX_JSON_BYTES) return response
      const clone = response.clone()
      const text = await clone.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return response
      }
      if (!isRecord(json)) return response
      const content = contentTextOf(protocol, json)
      const errorMessage =
        isRecord(json.error) && typeof json.error.message === "string" ? json.error.message : ""
      const quota =
        isQuotaModel(modelOf(protocol, json)) ||
        quotaTextState(content) === "yes" ||
        quotaTextState(errorMessage) === "yes"
      if (!quota) return response
      void response.body?.cancel().catch(() => {})
      return quotaErrorResponse(protocol, content || errorMessage)
    }
  } catch {
    /* 识别失败不影响正常转发 */
  }
  return response
}
