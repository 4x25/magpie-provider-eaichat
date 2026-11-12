/**
 * 云智助手（eaichat.ctyun.cn）客户端。
 *
 * 登录链路（与 CTYunPCKeepAlive 的实现同构）：
 *   IAM 登录（密码 SHA-256）→ CAS ticket → ticketAuthorize（AES-ECB 解出会话密钥 sk + JWT）。
 * 之后所有 portal 接口带 JWT cookie 与 Web-Signature 签名（buildSignature）。
 * 凭据只存在实例内存中，不落日志。
 */
import {
  ANTHROPIC_BASE,
  CALL_TIMEOUT_MS,
  DESK_BASE,
  EAI_BASE,
  EAI_VERSION,
  GATEWAY_AES_KEY,
  GATEWAY_URL,
  HEADERS,
  JWT_COOKIE,
  LOGIN_BUDGET_MS,
  OPENAI_BASE,
  PRODUCT_ID,
  TOKEN_TASK_DISPLAY_TYPE,
  WEB_CLIENT,
} from "./constants.ts"

import { aesEcbDecrypt, buildSignature, randomPrintable, randomUuid, rsaEncryptPkcs1Hex, randomHex, jwtPayload } from "./crypto.ts"
import { CookieJar, setCookiesOf } from "./http.ts"
import { LoginRefusedError, UpstreamError, isRecord, toNumber, toTrimmedString, type JsonRecord } from "./util.ts"

export interface EaiTokenUsage {
  totalTokens: number
  usedTokens: number
  expTokens: number
  remainTokens: number
}

export interface EaiTokenTask {
  taskDefId: number
  taskDefName: string
  currentProgress: number
  status: number
  canReceive: boolean
  reward: number
  checkedDays: number
}

export interface ApiKeyRow {
  id: string
  name: string
  key: string
}

/** 从若干候选字段里挖出数组。 */
function arrayOf(value: unknown): unknown[] {
  if (!isRecord(value)) return Array.isArray(value) ? value : []
  for (const field of ["records", "list", "data", "rows", "keys", "items"]) {
    if (Array.isArray(value[field])) return value[field]
  }
  return []
}

/** 从 Key 行里尽力读出密钥字符串。 */
function keyFieldOf(row: JsonRecord): string {
  for (const field of ["apiKey", "key", "keySecret", "secret", "token", "value"]) {
    const v = row[field]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (isRecord(v)) {
      const nested = keyFieldOf(v)
      if (nested) return nested
    }
  }
  return ""
}

/** IAM 登录需要人工验证的 code（不再自动重登）。 */
const MANUAL_CODES = new Set([51030, 51031, 51040, 51085, 51090, 51091, 30060])

interface RequestOptions {
  method?: string
  params?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface ClientOptions {
  base?: string
  deskBase?: string
  gatewayUrl?: string
  /** 注入的 fetch（测试用）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
}

export class EaiChatClient {
  private readonly base: string
  private readonly deskBase: string
  private readonly gatewayUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly jar = new CookieJar()
  private tenantId: number | null = null
  private sk: string | null = null
  private jwt: string | null = null
  private readonly xuid = `pubweb_${randomUuid()}`

  constructor(options: ClientOptions = {}) {
    this.base = options.base ?? EAI_BASE
    this.deskBase = options.deskBase ?? DESK_BASE
    this.gatewayUrl = options.gatewayUrl ?? GATEWAY_URL
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get isLoggedIn(): boolean {
    return this.sk !== null && this.jwt !== null
  }

  get token(): string | null {
    return this.jwt
  }

  get tenant(): number | null {
    return this.tenantId
  }

  /** JWT 的 exp（毫秒）；解析失败返回 null。 */
  jwtExpiresAt(): number | null {
    if (!this.jwt) return null
    const payload = jwtPayload(this.jwt)
    const exp = payload ? Number(payload.exp) : NaN
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
  }

  /** 上次登录完成时间（毫秒），未登录为 null。 */
  get loggedInAt(): number | null {
    return this.isLoggedIn ? this.jwtExpiresAt() : null
  }

  private async rawFetch(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "user-agent": HEADERS.userAgent,
      ...(options.headers ?? {}),
    }
    const cookie = this.jar.headerFor(url)
    if (cookie) headers.cookie = cookie

    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS),
      } as RequestInit)
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      throw new UpstreamError(`网络请求失败（${reason}）`)
    }
    this.jar.addFromResponse(setCookiesOf(res), url)
    return res
  }

  /** 登录后的 portal 接口（带签名）。401/40401 → sessionExpired。 */
  private async api(path: string, options: RequestOptions = {}): Promise<JsonRecord> {
    if (!this.isLoggedIn) throw new UpstreamError("会话未登录", { sessionExpired: true })

    const url = new URL(path.startsWith("http") ? path : `${this.base}${path}`)
    for (const [k, v] of Object.entries(options.params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }

    let body: string | undefined
    if (options.body !== undefined) body = JSON.stringify(options.body)

    const headers: Record<string, string> = {
      accept: HEADERS.acceptJson,
      origin: this.base,
      referer: `${this.base}/chat/`,
      "content-type": "application/json",
      "x-eai-mode": "eai",
      "x-eai-source": "web-eai",
      "x-eai-version": EAI_VERSION,
      "x-eai-env": "pubWeb",
      "x-eai-env-code": "",
      "x-eai-gw-code": "",
      "x-eai-xuid": this.xuid,
      "x-user-agent": HEADERS.userAgent,
      "x-client-trace-id": randomUuid(),
      "yl-main-version": EAI_VERSION,
      "yl-product-id": PRODUCT_ID,
      "yl-authorization": "",
      ...(options.headers ?? {}),
    }
    if (this.tenantId != null) headers["x-eai-tenant-id"] = String(this.tenantId)

    const sk = this.sk as string
    const signature = buildSignature({ params: options.params, dataString: body, sk })
    headers["web-signature"] = signature.sign
    headers["web-random"] = signature.random
    headers["web-timestamp"] = signature.timestamp

    const res = await this.rawFetch(url.toString(), {
      method: options.method ?? "GET",
      headers,
      body,
      timeoutMs: options.timeoutMs,
    })
    return this.parsePortalJson(res)
  }

  private async parsePortalJson(res: Response): Promise<JsonRecord> {
    if (res.status === 401) {
      this.clearSession()
      throw new UpstreamError("会话已过期（HTTP 401）", { sessionExpired: true, code: 401 })
    }
    const text = await res.text()
    if (!text) return {}
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new UpstreamError(`响应不是 JSON（HTTP ${res.status}）`)
    }
    if (isRecord(json)) {
      const resultCode = Number(json.resultCode)
      if (resultCode === 40401) {
        this.clearSession()
        throw new UpstreamError("会话已过期（40401）", { sessionExpired: true, code: 40401 })
      }
    }
    return isRecord(json) ? json : {}
  }

  private clearSession(): void {
    this.jar.clear()
    this.sk = null
    this.jwt = null
    this.tenantId = null
  }

  private async getGateway(timeoutMs: number): Promise<{ ssopk: string; ssopkid: string }> {
    const res = await this.rawFetch(this.gatewayUrl, {
      headers: { accept: HEADERS.acceptJson, origin: this.base },
      timeoutMs,
    })
    const json = (await res.json()) as JsonRecord
    if (typeof json.data !== "string" || !json.data) {
      throw new UpstreamError("网关配置为空")
    }
    const plain = aesEcbDecrypt(json.data.replace(/[\r\n]/g, ""), GATEWAY_AES_KEY)
    const gw = JSON.parse(plain) as JsonRecord
    const sso = isRecord(gw.sso) ? gw.sso : {}
    if (typeof sso.ssopk !== "string" || typeof sso.ssopkid !== "string") {
      throw new UpstreamError("网关配置缺少 sso.ssopk/ssopkid")
    }
    return { ssopk: sso.ssopk, ssopkid: sso.ssopkid }
  }

  /** 完整登录链路；成功后返回自身。passwordDigest 为 sha256(明文密码)（IAM 要求的口径）。 */
  async login(
    cred: { userAccount: string; passwordDigest: string },
    deadlineMs: number = Date.now() + LOGIN_BUDGET_MS,
  ): Promise<this> {
    if (!cred.userAccount || !cred.passwordDigest) throw new LoginRefusedError("缺少账号或密码")

    const budgeted = async <T>(run: (timeoutMs: number) => Promise<T>, timeoutMs: number): Promise<T> => {
      const remaining = deadlineMs - Date.now()
      if (remaining <= 0) throw new UpstreamError("登录超过整体预算")
      return run(Math.min(remaining, timeoutMs))
    }

    this.clearSession()
    const iamPrefix = `${this.deskBase}/cloudB/dy/iam`

    // 1. IAM 登录
    const loginRes = await budgeted(
      (timeoutMs) =>
        this.rawFetch(`${iamPrefix}/api/auth/iam/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: HEADERS.acceptJson,
            origin: this.deskBase,
            referer: `${iamPrefix}/?consent=false`,
          },
          body: JSON.stringify({
            userAccount: cred.userAccount,
            password: cred.passwordDigest,
            deviceCode: `iam:${randomHex(16).slice(0, 31)}`,
            deviceName: "iam:web",
          }),
          timeoutMs,
        }),
      CALL_TIMEOUT_MS,
    )
    const loginJson = (await loginRes.json()) as JsonRecord
    const loginCode = Number(loginJson.code)
    if (loginCode !== 0) {
      const msg = toTrimmedString(loginJson.message) || toTrimmedString(loginJson.msg)
      if (MANUAL_CODES.has(loginCode)) {
        throw new LoginRefusedError(`该账号要求人工验证（code=${loginCode}）`, loginCode)
      }
      if (loginCode === 51010) throw new LoginRefusedError("账号或密码不正确", 51010)
      if (loginCode === 51020) throw new LoginRefusedError("账号已被锁定", 51020)
      throw new UpstreamError(`IAM 登录失败（code=${loginCode}${msg ? `，${msg}` : ""}）`, { code: loginCode })
    }
    const loginData = isRecord(loginJson.data) ? loginJson.data : {}
    if (loginData.needSmsValidate === true) {
      throw new LoginRefusedError("该账号要求短信二次验证", 51090)
    }
    const tenantId = Number(loginData.tenantId)
    if (!Number.isFinite(tenantId)) throw new UpstreamError("IAM 登录响应缺少 tenantId")
    this.tenantId = tenantId

    // 2. CAS ticket
    const casUrl = `${iamPrefix}/api/auth/iam/cas/login?service=${encodeURIComponent(
      `${this.base}:443/chat/#/aichat`,
    )}&consent=false`
    const casRes = await budgeted(
      (timeoutMs) =>
        this.rawFetch(casUrl, {
          headers: { accept: HEADERS.acceptJson, referer: `${iamPrefix}/?consent=false` },
          timeoutMs,
        }),
      CALL_TIMEOUT_MS,
    )
    const location = casRes.headers.get("location")
    if (!location) throw new UpstreamError(`CAS 未返回 Location（HTTP ${casRes.status}）`)
    const locationUrl = new URL(location, casUrl)
    const ticket =
      locationUrl.searchParams.get("ticket") ??
      new URLSearchParams(locationUrl.hash.split("?")[1] ?? "").get("ticket")
    if (!ticket) throw new UpstreamError("CAS Location 中没有 ticket")

    // 3. ticketAuthorize
    const gateway = await budgeted((timeoutMs) => this.getGateway(timeoutMs), CALL_TIMEOUT_MS)
    const clientKey = randomPrintable(16)
    const clientKeyHex = rsaEncryptPkcs1Hex(gateway.ssopk, clientKey)

    const form = new URLSearchParams({
      loginType: "iamTicket",
      clientId: WEB_CLIENT,
      iamTicket: ticket,
      jwtType: "3",
      redirectUri: `${this.base}:443/chat/#/aichat`,
      clientKey: clientKeyHex,
      clientKeyId: gateway.ssopkid,
    })

    const authRes = await budgeted(
      (timeoutMs) =>
        this.rawFetch(`${this.base}/sso/login/v2/iam/ticketAuthorize`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            accept: HEADERS.acceptJson,
            origin: this.base,
            referer: `${this.base}/chat/`,
            "x-eai-mode": "eai",
            "x-eai-source": "web-eai",
            "x-eai-version": EAI_VERSION,
            "x-eai-xuid": this.xuid,
            "x-user-agent": HEADERS.userAgent,
            "x-client-trace-id": randomUuid(),
            "yl-main-version": EAI_VERSION,
            "yl-product-id": PRODUCT_ID,
            "yl-authorization": "",
          },
          body: form.toString(),
          timeoutMs,
        }),
      CALL_TIMEOUT_MS,
    )
    const authJson = (await authRes.json()) as JsonRecord
    const resultCode = Number(authJson.resultCode)
    if (resultCode !== 0) {
      throw new UpstreamError(`ticketAuthorize 失败（resultCode=${resultCode}）`, { code: resultCode })
    }
    const authData = isRecord(authJson.data) ? authJson.data : {}
    if (typeof authData.sessionKey !== "string" || !authData.sessionKey) {
      throw new UpstreamError("ticketAuthorize 未返回 sessionKey")
    }
    this.sk = aesEcbDecrypt(authData.sessionKey, clientKey)
    this.jwt = this.jar.get(JWT_COOKIE) ?? (typeof authData.jwt === "string" ? authData.jwt : null)
    if (!this.jwt) throw new UpstreamError("会话缺少 YL-Token")
    return this
  }

  /** Token 用量（上游路径拼写就是 summry）。 */
  async getTokenUsage(): Promise<EaiTokenUsage> {
    const json = await this.api("/ai/portal/wenc/v1/platform/cp/usage/summry")
    if (Number(json.resultCode) !== 0) throw new UpstreamError("Token 用量获取失败")
    const data = isRecord(json.data) ? json.data : {}
    const totalTokens = toNumber(data.totalTokens)
    const usedTokens = toNumber(data.usedTokens)
    const expTokens = toNumber(data.expTokens)
    const remainTokens =
      data.remainTokens === undefined || data.remainTokens === null
        ? Math.max(0, totalTokens - usedTokens - expTokens)
        : toNumber(data.remainTokens)
    return { totalTokens, usedTokens, expTokens, remainTokens }
  }

  /** Token 任务列表（displayTypes 过滤出签到/领取类任务）。 */
  async getTokenTasks(): Promise<EaiTokenTask[]> {
    const json = await this.api(
      "/ai/portal/wenc/v1/cp/mgr/api/openApi/marketing/api/userPoints/getTaskList",
      { params: { displayTypes: TOKEN_TASK_DISPLAY_TYPE } },
    )
    if (Number(json.resultCode) !== 0) throw new UpstreamError("Token 任务列表获取失败")
    const outer = isRecord(json.data) ? json.data : {}
    const code = Number(outer.code)
    if (Number.isFinite(code) && code !== 0) {
      throw new UpstreamError(toTrimmedString(outer.msg) || "Token 任务列表获取失败")
    }
    const rows = arrayOf(outer.data ?? outer)
    if (!Array.isArray(rows)) throw new UpstreamError("Token 任务列表为空")
    return rows
      .filter(isRecord)
      .map((row) => ({
        taskDefId: toNumber(row.taskDefId),
        taskDefName: toTrimmedString(row.taskDefName),
        currentProgress: toNumber(row.currentProgress),
        status: toNumber(row.status),
        canReceive: row.canReceive === true,
        reward: (Array.isArray(row.pointsList) ? row.pointsList.filter(isRecord) : []).reduce(
          (sum, item) => sum + toNumber(item.value),
          0,
        ),
        checkedDays: Object.values(
          isRecord(row.receiveProgressMap) ? row.receiveProgressMap : {},
        ).filter((v) => toNumber(v) === 1).length,
      }))
  }

  /** 签到/领取（同一个接口）。成功时上游 data.data === true。 */
  async receivePoints(taskDefId: number, progress: number): Promise<void> {
    const json = await this.api(
      "/ai/portal/wenc/v1/cp/mgr/api/openApi/marketing/api/userPoints/receivePointsV2",
      { params: { taskDefId, progress } },
    )
    if (Number(json.resultCode) !== 0) throw new UpstreamError("签到请求失败")
    const outer = isRecord(json.data) ? json.data : {}
    if (Number(outer.code) !== 0 || outer.data !== true) {
      throw new UpstreamError(toTrimmedString(outer.msg) || "签到请求被拒绝")
    }
  }

  /** 列出账号下的 API Key。 */
  async listApiKeys(): Promise<ApiKeyRow[]> {
    const json = await this.api("/ai/portal/wenc/v1/platform/cp/apiKeys")
    if (Number(json.resultCode) !== 0) throw new UpstreamError("API Key 列表获取失败")
    const rows = arrayOf(json.data)
    const out: ApiKeyRow[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      out.push({
        id: String(row.id ?? row.keyId ?? ""),
        name: toTrimmedString(row.name ?? row.keyName ?? row.displayname),
        key: keyFieldOf(row),
      })
    }
    return out
  }

  /** 创建 API Key；返回上游响应 data（字段名以实际响应为准，由 keyOfCreated 兼容读取）。 */
  async addApiKey(name: string): Promise<JsonRecord> {
    const json = await this.api("/ai/portal/wenc/v1/platform/cp/addApiKey", {
      method: "POST",
      body: { name, models: [] },
    })
    if (Number(json.resultCode) !== 0) throw new UpstreamError("API Key 创建失败")
    const outer = isRecord(json.data) ? json.data : {}
    const code = Number(outer.code)
    if (Number.isFinite(code) && code !== 0) {
      throw new UpstreamError(toTrimmedString(outer.msg) || "API Key 创建被拒绝")
    }
    return isRecord(outer.data) ? outer.data : outer
  }

  /** Anthropic 端点绝对地址。 */
  anthropicUrl(): string {
    return `${ANTHROPIC_BASE}/v1/messages`
  }

  /** OpenAI 端点绝对地址。 */
  openaiUrl(): string {
    return `${OPENAI_BASE}/chat/completions`
  }
}

/** 从 addApiKey 的响应 data 中尽力读出密钥字符串。 */
export function keyOfCreated(data: JsonRecord): string {
  const candidates = ["apiKey", "key", "keySecret", "secret", "token", "value", "data"]
  for (const field of candidates) {
    const v = data[field]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (isRecord(v)) {
      const nested = keyOfCreated(v)
      if (nested) return nested
    }
  }
  return ""
}
