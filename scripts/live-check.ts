/**
 * 实机验证脚本：读 .env 中的测试账号，验证登录、API Key、用量、签到与模型调用。
 * 输出不含账号明文、密码、完整密钥（密钥只显示末 4 位与长度）。
 * 用法：node --experimental-strip-types --no-warnings scripts/live-check.ts [--no-chat]
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { EaiChatClient, keyOfCreated } from "../src/eaichat.ts"
import { sha256Hex } from "../src/crypto.ts"
import { API_KEY_NAME } from "../src/constants.ts"
import { mapUpstreamUrl } from "../src/relay.ts"

function loadEnv(): { username: string; password: string } {
  const text = readFileSync(resolve(import.meta.dirname, "..", ".env"), "utf8")
  const username = /^EAICHAT_USERNAME=(.*)$/m.exec(text)?.[1]?.trim() ?? ""
  const password = /^EAICHAT_PASSWORD=(.*)$/m.exec(text)?.[1]?.trim() ?? ""
  if (!username || !password) throw new Error(".env 缺少 EAICHAT_USERNAME / EAICHAT_PASSWORD")
  return { username, password }
}

async function retry<T>(label: string, fn: () => Promise<T>, times = 5): Promise<T> {
  let last: unknown
  for (let i = 0; i < times; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      console.log(`  重试 ${label}（${i + 1}/${times}）：${e instanceof Error ? e.message : e}`)
      await new Promise((r) => setTimeout(r, 2500))
    }
  }
  throw last
}

const mask = (s: string) => (s.length <= 6 ? s[0] + "***" : s.slice(0, 3) + "***" + s.slice(-6))
const keyHint = (k: string) => `len=${k.length} …${k.slice(-4)}`

async function main() {
  const env = loadEnv()
  const noChat = process.argv.includes("--no-chat")
  const client = new EaiChatClient()

  console.log("== 1. 登录 ==")
  await retry("登录", () => client.login({ userAccount: env.username, passwordDigest: sha256Hex(env.password) }))
  console.log(`登录成功：账号 ${mask(env.username)}，tenant=${client.tenant}`)
  console.log(`JWT 到期：${new Date(client.jwtExpiresAt() ?? 0).toISOString()}`)

  console.log("== 2. 模型清单 ==")
  const models = await retry("models", () => client.listModels())
  if (models.length === 0) throw new Error("上游模型清单为空")
  console.log(`共 ${models.length} 个模型`)
  for (const model of models) {
    console.log(`  ${model.id.padEnd(28)} ${model.name}  [${model.apis.join(", ") || "-"}]`)
  }

  console.log("== 3. API Key 查找/创建 ==")
  let key = ""
  const rows = await retry("apiKeys", () => client.listApiKeys())
  console.log(`账号下共 ${rows.length} 个 Key`)
  const hit = rows.find((r) => r.name === API_KEY_NAME && r.key)
  if (hit) {
    key = hit.key
    console.log(`命中 ${API_KEY_NAME}（列表回显：${keyHint(key)}）`)
  } else {
    const hasName = rows.some((r) => r.name === API_KEY_NAME)
    console.log(`未在列表中命中 ${API_KEY_NAME}（同名无值：${hasName}），创建…`)
    const created = await retry("addApiKey", () => client.addApiKey(API_KEY_NAME))
    key = keyOfCreated(created)
    if (!key) {
      const again = await retry("apiKeys 复查", () => client.listApiKeys())
      key = again.find((r) => r.name === API_KEY_NAME && r.key)?.key ?? ""
      console.log(`创建响应未回显，复查列表：${key ? keyHint(key) : "仍无"}`)
    } else {
      console.log(`创建成功（响应回显：${keyHint(key)}）`)
    }
  }
  if (!key) throw new Error("无法获得 API Key")

  console.log("== 4. Token 用量 ==")
  const usage = await retry("usage", () => client.getTokenUsage())
  console.log(
    `total=${usage.totalTokens} used=${usage.usedTokens} exp=${usage.expTokens} remain=${usage.remainTokens}`,
  )

  console.log("== 5. 每日签到 ==")
  const tasks = await retry("getTaskList", () => client.getTokenTasks())
  const daily = tasks.find((t) => t.taskDefId === 3001)
  if (!daily) {
    console.log(`任务列表 ${tasks.length} 项，未找到每日签到任务；任务名：${tasks.map((t) => t.taskDefName).join("、")}`)
  } else {
    console.log(
      `每日签到：canReceive=${daily.canReceive} status=${daily.status} progress=${daily.currentProgress} reward=${daily.reward} checkedDays=${daily.checkedDays}`,
    )
    if (daily.canReceive) {
      await retry("receivePointsV2", () => client.receivePoints(3001, daily.currentProgress))
      console.log(`签到成功：+${daily.reward}`)
      const after = await retry("usage 复查", () => client.getTokenUsage())
      console.log(`复查用量：total=${after.totalTokens} used=${after.usedTokens} remain=${after.remainTokens}`)
    } else {
      console.log("今日已签到，跳过")
    }
  }

  if (noChat) {
    console.log("== 6. 模型调用（--no-chat 跳过）==")
    return
  }

  console.log("== 6. 模型调用（Anthropic 协议，max_tokens=16）==")
  const url = mapUpstreamUrl("https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic/v1/messages")
  const res = await retry("messages", async () => {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 实测：两个端点都只认 Authorization: Bearer（Anthropic 端点不认 x-api-key）
        authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "glm-5.3-flash",
        max_tokens: 16,
        messages: [{ role: "user", content: "回复两个字：收到" }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
    return r
  })
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
    model?: string
  }
  console.log(`模型：${json.model ?? "?"}`)
  console.log(
    `内容：${(json.content ?? []).map((c) => c.text ?? `[${c.type}]`).join("")}`,
  )
  console.log(`用量：input=${json.usage?.input_tokens ?? "?"} output=${json.usage?.output_tokens ?? "?"}`)

  const usageAfter = await retry("usage 终查", () => client.getTokenUsage())
  console.log(
    `调用后用量：total=${usageAfter.totalTokens} used=${usageAfter.usedTokens} remain=${usageAfter.remainTokens}`,
  )
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e)
  process.exit(1)
})
