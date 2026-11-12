/**
 * 账号会话管理：按账号（userHash）持有客户端、续登与 API Key 解析。
 * 并发规则：同一账号同一时刻至多一次登录、一次 Key 解析；续登后重试一次。
 */
import { API_KEY_NAME, USAGE_TTL_MS } from "./constants.ts"
import { EaiChatClient, keyOfCreated, type EaiTokenUsage } from "./eaichat.ts"
import { sha256Hex } from "./crypto.ts"
import { LoginRefusedError, UpstreamError, isRecord, toTrimmedString } from "./util.ts"

/** plugin-auth.json 中保存的登录信息（type: "oauth"）。
 *
 * `refresh`（= pwHash）与 `access`（= 最新 JWT）是宿主认的标准 oauth 字段；
 * `pwHash`/`userHash` 是插件自己的同值字段。client.auth.set 是整对象替换，
 * 因此运行期写回时必须带上完整形状，否则会把宿主保存的 access 抹掉。
 */
export interface StoredAuth {
  type: "oauth"
  /** 账号（仅用于显示与命名，accountId 同值）。 */
  user: string
  /** sha256(user)：会话表的键，避免账号明文做键。 */
  userHash: string
  /** sha256(password)：IAM 登录所需的密码摘要（登录链路上游要的就是这个口径）。 */
  pwHash: string
  /** 宿主标准 oauth 字段：refresh token（本供应商即密码摘要）。 */
  refresh: string
  /** 宿主标准 oauth 字段：当前 JWT。 */
  access: string
  accountId: string
  /** 已解析出的 API Key（未填时自动查/建）。 */
  apiKey?: string
  /** JWT 到期时间（毫秒）。 */
  expires: number
}

export function buildAuth(user: string, passwordDigest: string, apiKey?: string): StoredAuth {
  const trimmed = toTrimmedString(user)
  return {
    type: "oauth",
    user: trimmed,
    userHash: sha256Hex(trimmed),
    pwHash: passwordDigest,
    refresh: passwordDigest,
    access: "",
    accountId: trimmed,
    ...(apiKey ? { apiKey } : {}),
    expires: 0,
  }
}

/** 从任意 auth 对象还原 StoredAuth（容忍字段缺失；pwHash 兼容 authorize 写入的 refresh 字段）。 */
export function asStoredAuth(auth: unknown): StoredAuth | null {
  if (!isRecord(auth)) return null
  const userHash = toTrimmedString(auth.userHash) || (toTrimmedString(auth.user) ? sha256Hex(toTrimmedString(auth.user)) : "")
  const pwHash = toTrimmedString(auth.pwHash) || toTrimmedString(auth.refresh)
  if (!userHash || !pwHash) return null
  const expires = Number(auth.expires)
  return {
    type: "oauth",
    user: toTrimmedString(auth.user),
    userHash,
    pwHash,
    refresh: pwHash,
    access: toTrimmedString(auth.access),
    accountId: toTrimmedString(auth.accountId) || toTrimmedString(auth.user),
    ...(toTrimmedString(auth.apiKey) ? { apiKey: toTrimmedString(auth.apiKey) } : {}),
    expires: Number.isFinite(expires) && expires > 0 ? expires : 0,
  }
}

export interface SessionDeps {
  /** client.auth.set：把更新写回当前账号（宿主提供）。 */
  save: (body: StoredAuth) => Promise<boolean>
  log: (level: "info" | "warn" | "error", message: string) => void
  /** 客户端工厂（测试注入用）。 */
  newClient?: () => EaiChatClient
}

const FRESH_MS = 60_000

export class AccountSession {
  private client: EaiChatClient | null = null
  private loginPromise: Promise<EaiChatClient> | null = null
  private keyPromise: Promise<string> | null = null
  private usageCache: { at: number; value: EaiTokenUsage } | null = null
  private readonly deps: SessionDeps

  constructor(deps: SessionDeps) {
    this.deps = deps
  }

  /** 确保已登录：未登录/临期/force 时走完整链路（同账号并发合并为一次）。 */
  ensureClient(auth: StoredAuth, options: { force?: boolean } = {}): Promise<EaiChatClient> {
    if (!options.force && this.client?.isLoggedIn) {
      const expires = this.client.jwtExpiresAt() ?? 0
      if (expires - Date.now() > FRESH_MS) return Promise.resolve(this.client)
    }
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = this.doLogin(auth)
    return this.loginPromise
  }

  private async doLogin(auth: StoredAuth): Promise<EaiChatClient> {
    try {
      const client = this.deps.newClient?.() ?? new EaiChatClient()
      // DNS 抖动重试：同一账号同一时刻的登录只在这里重试，凭据错误不重试
      await this.withNetRetry(() => client.login({ userAccount: auth.user, passwordDigest: auth.pwHash }))
      this.client = client
      this.usageCache = null
      const expires = client.jwtExpiresAt() ?? 0
      const access = client.token ?? ""
      if (expires > (auth.expires ?? 0) || access !== auth.access) {
        await this.deps.save({ ...auth, access, expires })
      }
      return client
    } catch (e) {
      this.client = null
      throw e
    } finally {
      this.loginPromise = null
    }
  }

  /** 网络类错误重试一次（间隔 2s）；业务拒绝/会话过期不重试。 */
  private async withNetRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof LoginRefusedError || (e instanceof UpstreamError && e.sessionExpired)) throw e
      if (e instanceof UpstreamError && /网络|timeout|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(e.message)) {
        this.deps.log("warn", `eaichat: 网络抖动，2 秒后重试登录（${e.message}）`)
        await new Promise((r) => setTimeout(r, 2000))
        return await fn()
      }
      throw e
    }
  }

  /** 登录后收养一个现成客户端（authorize 场景，避免紧接着重复登录）。 */
  adopt(client: EaiChatClient): void {
    if (client.isLoggedIn) {
      this.client = client
      this.usageCache = null
    }
  }

  /** 当前客户端（可能为 null）。 */
  currentClient(): EaiChatClient | null {
    return this.client?.isLoggedIn ? this.client : null
  }

  /**
   * 解析 API Key：auth 已有 → 原样；否则查名下 `magpie-provider-eaichat`，
   * 没有则创建；创建响应读不出密钥时重查一次。结果写回 auth。
   */
  async ensureApiKey(auth: StoredAuth, client: EaiChatClient): Promise<string> {
    if (auth.apiKey) return auth.apiKey
    if (this.keyPromise) return this.keyPromise
    this.keyPromise = this.doEnsureApiKey(auth, client)
    return this.keyPromise
  }

  private async doEnsureApiKey(auth: StoredAuth, client: EaiChatClient): Promise<string> {
    try {
      let key = ""
      try {
        const rows = await this.withSessionRetry(auth, (c) => c.listApiKeys())
        const hit = rows.find((row) => row.name === API_KEY_NAME && row.key)
        if (hit) key = hit.key
      } catch (e) {
        this.deps.log("warn", `eaichat: API Key 列表获取失败（${errText(e)}）`)
      }

      if (!key) {
        this.deps.log("info", `eaichat: 未找到名为 ${API_KEY_NAME} 的 API Key，自动创建`)
        const created = await this.withSessionRetry(auth, (c) => c.addApiKey(API_KEY_NAME))
        key = keyOfCreated(created)
        if (!key) {
          // 创建成功但响应里没有密钥：重查列表（部分上游只在列表里回显一次）
          const rows = await this.withSessionRetry(auth, (c) => c.listApiKeys())
          const hit = rows.find((row) => row.name === API_KEY_NAME && row.key)
          if (hit) key = hit.key
        }
      }

      if (!key) {
        throw new UpstreamError("无法获得 API Key：请在 Token 中心手动创建后填入")
      }

      await this.deps.save({ ...auth, apiKey: key })
      return key
    } catch (e) {
      // 失败不缓存：下次调用重试
      if (e instanceof LoginRefusedError || (e instanceof UpstreamError && e.sessionExpired)) throw e
      this.deps.log("warn", `eaichat: API Key 解析失败（${errText(e)}）`)
      throw e
    } finally {
      this.keyPromise = null
    }
  }

  /** 读取 Token 用量（带 TTL 缓存；会话失效自动重登一次）。 */
  async readUsage(auth: StoredAuth): Promise<{
    totalTokens: number
    usedTokens: number
    expTokens: number
    remainTokens: number
  }> {
    const hit = this.usageCache
    if (hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.value
    const value = await this.withSessionRetry(auth, (client) => client.getTokenUsage())
    this.usageCache = { at: Date.now(), value }
    return value
  }

  /** 在（必要时重登的）会话上执行 fn；fn 抛 sessionExpired 时重登一次再试。 */
  async withSessionRetry<T>(auth: StoredAuth, fn: (client: EaiChatClient) => Promise<T>): Promise<T> {
    let client = await this.ensureClient(auth)
    try {
      return await fn(client)
    } catch (e) {
      if (!(e instanceof UpstreamError) || !e.sessionExpired) throw e
      this.usageCache = null
      client = await this.ensureClient(auth, { force: true })
      return await fn(client)
    }
  }

  /** auth.refresh 的实现：重登并返回要合并进 auth 的字段。 */
  async renew(auth: StoredAuth): Promise<Partial<StoredAuth>> {
    const client = await this.ensureClient(auth, { force: true })
    const expires = client.jwtExpiresAt() ?? 0
    const fields: Partial<StoredAuth> = { expires }
    if (!auth.apiKey) {
      const key = await this.ensureApiKey(auth, client)
      fields.apiKey = key
    }
    return fields
  }
}

/** 按账号分组的会话表（宿主进程内）。 */
const sessions = new Map<string, AccountSession>()

export function sessionOf(auth: StoredAuth, deps: SessionDeps): AccountSession {
  let s = sessions.get(auth.userHash)
  if (!s) {
    s = new AccountSession(deps)
    sessions.set(auth.userHash, s)
  }
  return s
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
