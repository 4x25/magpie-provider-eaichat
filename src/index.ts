/**
 * magpie 插件入口：云智助手（eaichat.ctyun.cn）Token 中心。
 *
 * - 登录：账号 + 密码（IAM→CAS→ticketAuthorize），API Key 可选（留空自动查/建）
 * - 自动续登：auth.refresh（到期前重走登录链路）
 * - 每日签到：auth.checkin（taskDefId=3001，经 magpie 的签到调度）
 * - 用量显示：auth.usage（platform/cp/usage/summry）
 * - 模型转发：loader.fetch，默认 Anthropic Messages，可用插件开关切换 OpenAI Chat
 */
import { ANTHROPIC_BASE, API_KEY_NAME, DAILY_TASK_ID, OPENAI_BASE, PROVIDER_ID } from "./constants.ts"
import { EaiChatClient, keyOfCreated } from "./eaichat.ts"
import { asStoredAuth, buildAuth, errText, sessionOf, type StoredAuth } from "./state.ts"
import { modelsFor, WIRES, type WireProtocol } from "./models.ts"
import { usageOf } from "./usage.ts"
import { claimedOf, planCheckin, planToOutcome, settleAfterRefused } from "./checkin.ts"
import { relayFetch } from "./relay.ts"
import { sha256Hex } from "./crypto.ts"
import { LoginRefusedError, UpstreamError, toTrimmedString } from "./util.ts"

/** 到期前 6 小时触发续登。 */
const REFRESH_LEAD_MS = 6 * 60 * 60 * 1000

interface MagpieInput {
  client?: {
    auth?: { set?: (args: { path: { id: string }; body: unknown }) => Promise<unknown> }
    app?: { log?: (args: { body: { service?: string; level?: string; message?: string } }) => Promise<unknown> }
  }
  magpie?: { option?: (provider: string, key: string) => unknown }
}

export interface PluginOptions {
  baseURL?: string
  protocol?: string
  use_openai?: boolean
}

export async function EAIChatPlugin(input: MagpieInput = {}, options: PluginOptions = {}) {
  const magpie = input.magpie

  const log = (level: "info" | "warn" | "error", message: string) => {
    try {
      input.client?.app?.log?.({ body: { service: "eaichat", level, message } })
    } catch {
      /* 日志尽力而为 */
    }
  }

  const save = async (body: StoredAuth): Promise<boolean> => {
    try {
      await input.client?.auth?.set?.({ path: { id: PROVIDER_ID }, body })
      return true
    } catch {
      return false
    }
  }

  const deps = { save, log }

  /** 协议开关：auth.options 的 GUI 开关（magpie.option）优先，plugins.json 的插件 options 兜底。 */
  const wireProtocol = (): WireProtocol => {
    try {
      const v = magpie?.option?.(PROVIDER_ID, "use_openai")
      if (v === true) return "openai"
      if (v === false) return "anthropic"
    } catch {
      /* 旧宿主 */
    }
    // 默认 OpenAI：思考档位（reasoning_effort / enable_thinking）只在 OpenAI 端点生效。
    return options.use_openai === false ? "anthropic" : "openai"
  }

  return {
    config: async (cfg: { provider?: Record<string, unknown> }) => {
      cfg.provider ??= {}
      if (!cfg.provider[PROVIDER_ID]) {
        const wire = wireProtocol()
        cfg.provider[PROVIDER_ID] = {
          name: "云智助手",
          npm: WIRES[wire].npm,
          api: wire === "openai" ? OPENAI_BASE : ANTHROPIC_BASE,
          models: modelsFor(wire),
        }
      }
    },

    provider: {
      id: PROVIDER_ID,

      async models(provider: { models?: Record<string, unknown> }, ctx: { auth?: unknown } = {}) {
        const wire = wireProtocol()
        const declared =
          provider?.models && Object.keys(provider.models).length > 0
            ? provider.models
            : modelsFor(wire)
        if (!ctx?.auth) return declared

        const auth = asStoredAuth(ctx.auth)
        if (!auth) return declared

        try {
          const session = sessionOf(auth, deps)
          const client = await session.ensureClient(auth)
          await session.ensureApiKey(auth, client)
          const upstream = await session.readModels(auth)
          if (upstream.length === 0) throw new UpstreamError("上游模型列表为空")
          return modelsFor(wire, upstream)
        } catch (e) {
          if (e instanceof LoginRefusedError) {
            throw Object.assign(new Error(`${errText(e)}，请重新登录`), { signIn: "expired" })
          }
          // 上游清单暂不可用：保留声明列表（magpie 视为 fallback）
          log("warn", `eaichat: 模型列表获取失败，使用内置回退清单（${errText(e)}）`)
          return declared
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,
      refreshLead: REFRESH_LEAD_MS,

      options: [
        {
          key: "use_openai",
          label: "Use OpenAI Chat Completions protocol",
          labels: { zh: "使用 OpenAI Chat Completions 协议" },
          description:
            "On (default) talks to the OpenAI Chat Completions endpoint, which carries thinking levels; off talks to the Anthropic Messages endpoint. Takes effect from the next request.",
          descriptions: {
            zh: "打开（默认）走 OpenAI Chat Completions 端点，可用思考档位；关闭走 Anthropic Messages 端点。从下一个请求起生效。",
          },
          default: true,
          placement: "top",
        },
      ],

      methods: [
        {
          type: "oauth",
          label: "账号密码登录",
          prompts: [
            {
              type: "text",
              key: "username",
              message: "云智助手账号（手机号或邮箱）",
              validate: (v: string) =>
                toTrimmedString(v) ? undefined : "账号不能为空",
            },
            {
              type: "password",
              key: "password",
              message: "云智助手密码",
              validate: (v: string) => (String(v ?? "") ? undefined : "密码不能为空"),
            },
            {
              type: "password",
              key: "apiKey",
              message: `API Key（可选；留空自动使用/创建名为 ${API_KEY_NAME} 的 Key）`,
              placeholder: "留空则自动解析",
            },
          ],
          authorize(inputs: Record<string, string>): AuthorizeResult {
            const user = toTrimmedString(inputs?.username)
            const password = String(inputs?.password ?? "")
            if (!user || !password) {
              return { type: "failed", error: "请输入账号和密码" }
            }
            const inputKey = toTrimmedString(inputs?.apiKey)

            return {
              url: "",
              instructions: "正在登录云智助手并解析 API Key……",
              method: "auto",
              async callback(): Promise<SignInResult> {
                let client: EaiChatClient
                try {
                  client = new EaiChatClient()
                  await client.login({ userAccount: user, passwordDigest: sha256Hex(password) })
                } catch (e) {
                  return { type: "failed", error: errText(e) }
                }

                let apiKey = inputKey
                if (!apiKey) {
                  try {
                    apiKey = await findOrCreateKey(client)
                  } catch (e) {
                    return { type: "failed", error: errText(e) }
                  }
                }

                const auth = buildAuth(user, sha256Hex(password), apiKey)
                auth.expires = client.jwtExpiresAt() ?? 0

                // 收养会话：紧随其后的 loader 不再重复登录
                sessionOf(auth, deps).adopt(client)

                return {
                  type: "success",
                  refresh: auth.pwHash,
                  access: client.token ?? "",
                  expires: auth.expires,
                  accountId: auth.accountId,
                  user: auth.user,
                  userHash: auth.userHash,
                  ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
                }
              },
            }
          },
        },
      ],

      async loader(getAuth: () => Promise<unknown>) {
        const auth = asStoredAuth(await getAuth())
        if (!auth) return {}
        const session = sessionOf(auth, deps)
        try {
          const client = await session.ensureClient(auth)
          const apiKey = await session.ensureApiKey(auth, client)
          const wire = wireProtocol()
          return {
            baseURL: wire === "openai" ? OPENAI_BASE : `${ANTHROPIC_BASE}/v1`,
            apiKey,
            headers: {},
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
              relayFetch(input, init, { apiKey }),
          }
        } catch (e) {
          if (e instanceof LoginRefusedError) {
            throw Object.assign(new Error(`${errText(e)}，请重新登录`), { signIn: "expired" })
          }
          throw e
        }
      },

      async usage(getAuth: () => Promise<unknown>) {
        const auth = asStoredAuth(await getAuth())
        if (!auth) return { error: "未登录", signIn: "expired" }
        const session = sessionOf(auth, deps)
        try {
          const usage = await session.readUsage(auth)
          return usageOf(usage, auth.user)
        } catch (e) {
          if (e instanceof LoginRefusedError) {
            return { error: `${errText(e)}，请重新登录`, signIn: "expired" }
          }
          if (e instanceof UpstreamError && e.sessionExpired) {
            return { error: "会话已过期且自动重登失败，请重新登录", signIn: "expired" }
          }
          return { error: errText(e), signIn: "kept" }
        }
      },

      async refresh(auth: unknown) {
        const stored = asStoredAuth(auth)
        if (!stored) {
          throw Object.assign(new Error("登录信息不完整，请重新登录"), { signIn: "expired" })
        }
        const session = sessionOf(stored, deps)
        try {
          const fields = await session.renew(stored)
          return { access: session.currentClient()?.token ?? "", ...fields }
        } catch (e) {
          if (e instanceof LoginRefusedError) {
            throw Object.assign(new Error(`${errText(e)}，请重新登录`), { signIn: "expired" })
          }
          throw e
        }
      },

      async checkin(getAuth: () => Promise<unknown>) {
        const auth = asStoredAuth(await getAuth())
        if (!auth) return { outcome: "failed", message: "未登录" }
        const session = sessionOf(auth, deps)

        let tasks
        try {
          tasks = await session.withSessionRetry(auth, (c) => c.getTokenTasks())
        } catch (e) {
          if (e instanceof LoginRefusedError) {
            return { outcome: "failed", message: `${errText(e)}，请重新登录` }
          }
          return { outcome: "failed", message: errText(e) }
        }

        const plan = planCheckin(tasks)
        if (plan.kind !== "claim") return planToOutcome(plan)

        try {
          await session.withSessionRetry(auth, (c) => c.receivePoints(DAILY_TASK_ID, plan.progress))
          return claimedOf(plan.credit, plan.streak)
        } catch (e) {
          // 业务拒绝（多为重复签到）：复查任务状态后再定性
          const again = await session
            .withSessionRetry(auth, (c) => c.getTokenTasks())
            .catch(() => null)
          if (again) return settleAfterRefused(again, errText(e))
          return { outcome: "failed", message: errText(e) }
        }
      },
    },
  }
}

type SignInResult =
  | { type: "success"; [k: string]: unknown }
  | { type: "failed"; error: string }

type AuthorizeResult =
  | { type: "failed"; error: string }
  | {
      url: string
      instructions: string
      method: "auto"
      callback: () => Promise<SignInResult>
    }

/** 登录后查/建 API Key（authorize 内联使用，不走会话表）。 */
async function findOrCreateKey(client: EaiChatClient): Promise<string> {
  let key = ""
  try {
    const rows = await client.listApiKeys()
    const hit = rows.find((row) => row.name === API_KEY_NAME && row.key)
    if (hit) key = hit.key
  } catch {
    /* 查询失败则尝试创建 */
  }
  if (!key) {
    const created = await client.addApiKey(API_KEY_NAME)
    key = keyOfCreated(created)
    if (!key) {
      const rows = await client.listApiKeys()
      const hit = rows.find((row) => row.name === API_KEY_NAME && row.key)
      if (hit) key = hit.key
    }
  }
  if (!key) {
    throw new UpstreamError("无法获得 API Key：请在 Token 中心手动创建后填入")
  }
  return key
}

export default EAIChatPlugin

/** 测试入口。 */
export const _internal = {
  findOrCreateKey,
  wireProtocolOf: (magpie: MagpieInput["magpie"]) => {
    try {
      return magpie?.option?.(PROVIDER_ID, "use_openai") === true ? "openai" : "anthropic"
    } catch {
      return "anthropic"
    }
  },
  REFRESH_LEAD_MS,
}
