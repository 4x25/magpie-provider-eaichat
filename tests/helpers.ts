/** 测试用假上游：完整模拟登录链路与 portal 接口。 */
import crypto from "node:crypto"
import { aesEcbEncrypt, rsaDecryptPkcs1 } from "../src/crypto.ts"
import { GATEWAY_AES_KEY } from "../src/constants.ts"

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface FakeState {
  /** IAM 登录是否成功。 */
  iamCode: number
  /** portal 接口是否认当前 JWT（false → 401）。 */
  jwtValid: boolean
  usage: { totalTokens: number; usedTokens: number; expTokens: number; remainTokens: number }
  /** 上游模型清单（/platform/cp/models）。 */
  models: Array<Record<string, unknown>>
  /** /platform/cp/models 的 resultCode（非 0 模拟失败）。 */
  modelsResultCode: number
  tasks: Array<Record<string, unknown>>
  keys: Array<{ id: string; name: string; apiKey: string }>
  /** addApiKey 成功时是否在响应中回显密钥。 */
  addKeyEchoes: boolean
  /** receivePointsV2 的拒绝文案（空 = 成功）。 */
  receiveRefusal: string
}

export function fakeJwt(expiresMs: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(expiresMs / 1000) })}.${"sig".repeat(8)}`
}

export function makeFakeUpstream() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64")
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

  const sessionKey = "0123456789abcdef0123456789abcdef" // 32 bytes
  const state: FakeState = {
    iamCode: 0,
    jwtValid: true,
    usage: { totalTokens: 800_000, usedTokens: 1_000, expTokens: 0, remainTokens: 799_000 },
    models: [
      { id: 12, title: "DeepSeek-V4.1-Flash-1017", model: "deepseek-v4.1-flash", api: "openai-completions,anthropic-messages" },
      { id: 11, title: "GLM-5.3-Flash", model: "glm-5.3-flash", api: "openai-completions,anthropic-messages" },
      { id: 7, title: "DeepSeek-V4-Pro-0813", model: "deepseek-v4-pro-0813-oc", api: "openai-completions,anthropic-messages" },
      { id: 8, title: "GLM-5.3", model: "glm-5.3-oc", api: "openai-completions,anthropic-messages" },
      { id: 13, title: "Qwen-3.8-Flash", model: "qwen-3.8-flash", api: "openai-completions,anthropic-messages" },
    ],
    modelsResultCode: 0,
    tasks: [],
    keys: [],
    addKeyEchoes: true,
    receiveRefusal: "",
  }
  let jwt = fakeJwt(Date.now() + 7 * 24 * 3600_000)
  const requests: RecordedRequest[] = []
  const counters = { addApiKey: 0, receivePoints: 0, logins: 0, modelLists: 0 }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

  const verifySignature = (req: RecordedRequest): boolean => {
    const u = new URL(req.url)
    const query = [...u.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&")
    let payload = query
    if (req.body !== undefined) {
      const digest = crypto.createHash("md5").update(req.body, "utf8").digest("hex")
      payload = payload ? `${payload}&${digest}` : digest
    }
    const toSign = `${payload ? `${payload}&` : ""}${sessionKey}&${req.headers["web-timestamp"]}&${req.headers["web-random"]}`
    const sign = crypto.createHash("sha256").update(toSign, "utf8").digest("hex")
    return req.headers["web-signature"] === sign
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? (typeof input === "object" && "url" in input ? input.method : "GET")).toUpperCase()
    const headers: Record<string, string> = {}
    const h = init?.headers ?? (typeof input === "object" && "url" in input ? input.headers : undefined)
    if (h) {
      if (h instanceof Headers) for (const [k, v] of h.entries()) headers[k.toLowerCase()] = v
      else if (Array.isArray(h)) for (const [k, v] of h as [string, string][]) headers[k.toLowerCase()] = String(v)
      else for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v
    }
    const body = typeof init?.body === "string" ? init.body : undefined
    const req: RecordedRequest = { url, method, headers, body }
    requests.push(req)

    // ---- IAM ----
    if (url.startsWith("https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/login")) {
      counters.logins++
      const ok = state.iamCode === 0 && body?.includes(sha256HexOf("correct-password"))
      if (!ok) return json({ code: 51010, message: "账号或密码不正确" })
      return json({ code: 0, data: { tenantId: 103762 } })
    }
    if (url.startsWith("https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/cas/login")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://eaichat.ctyun.cn:443/chat/#/aichat?ticket=TICKET123" },
      })
    }

    // ---- 网关配置 ----
    if (url === "https://gwyilian.ctyun.cn/server/eaiSysInfo") {
      return json({ data: aesEcbEncrypt(JSON.stringify({ sso: { ssopk: spki, ssopkid: "kid-1" } }), GATEWAY_AES_KEY) })
    }

    // ---- ticketAuthorize ----
    if (url.endsWith("/sso/login/v2/iam/ticketAuthorize")) {
      const form = new URLSearchParams(body ?? "")
      const clientKeyHex = form.get("clientKey") ?? ""
      const clientKey = rsaDecryptPkcs1(pem, Buffer.from(clientKeyHex, "hex"))
      const encSessionKey = aesEcbEncrypt(sessionKey, clientKey)
      return json(
        { resultCode: 0, data: { sessionKey: encSessionKey } },
        200,
        { "set-cookie": `YL-Token=${jwt}; Path=/; Domain=.ctyun.cn` },
      )
    }

    // ---- portal（需 JWT + 签名）----
    if (url.includes("/ai/portal/")) {
      if (!state.jwtValid || !headers.cookie?.includes(`YL-Token=${jwt}`)) {
        return json({ resultCode: 40401, msg: "未登录" }, 200)
      }
      if (!verifySignature(req)) {
        return json({ resultCode: 40401, msg: "签名错误" }, 200)
      }
      if (url.endsWith("/platform/cp/usage/summry")) {
        return json({ resultCode: 0, data: state.usage })
      }
      if (url.includes("/userPoints/getTaskList")) {
        return json({ resultCode: 0, data: { code: 0, data: state.tasks } })
      }
      if (url.includes("/userPoints/receivePointsV2")) {
        counters.receivePoints++
        if (state.receiveRefusal) {
          return json({ resultCode: 0, data: { code: -1, msg: state.receiveRefusal, data: false } })
        }
        return json({ resultCode: 0, data: { code: 0, data: true } })
      }
      if (url.endsWith("/platform/cp/models")) {
        counters.modelLists++
        return json({ resultCode: state.modelsResultCode, data: state.models })
      }
      if (url.endsWith("/platform/cp/apiKeys")) {
        return json({ resultCode: 0, data: { records: state.keys } })
      }
      if (url.endsWith("/platform/cp/addApiKey")) {
        counters.addApiKey++
        const name = JSON.parse(body ?? "{}").name
        const key = `sk-eai-${counters.addApiKey}`
        state.keys.push({ id: `id-${counters.addApiKey}`, name, apiKey: key })
        const payload = state.addKeyEchoes
          ? { resultCode: 0, data: { code: 0, data: { apiKey: key } } }
          : { resultCode: 0, data: { code: 0 } }
        return json(payload)
      }
    }

    return json({ resultCode: -1, msg: `fake: no route for ${method} ${url}` }, 404)
  }

  return { fetchImpl, state, requests, counters, setJwt: (j: string) => (jwt = j) }
}

function sha256HexOf(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex")
}

/** 构造一个「每日签到」任务行。 */
export function dailyTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskDefId: 3001,
    taskDefName: "每日签到",
    taskCalendarType: 1,
    pointsList: [{ type: 600, typeDesc: "TOKEN", value: 100_000 }],
    currentProgress: 0,
    totalProgress: 1,
    status: 0,
    canReceive: true,
    isSatisfiedCondition: true,
    receiveProgressMap: { "2026-11-11": 1 },
    taskSort: 1,
    ...overrides,
  }
}
