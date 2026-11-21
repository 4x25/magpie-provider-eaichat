import { strict as assert } from "node:assert"
import { test } from "node:test"
import { EaiChatClient, keyOfCreated } from "../src/eaichat.ts"
import { sha256Hex } from "../src/crypto.ts"
import { UpstreamError } from "../src/util.ts"
import { dailyTask, fakeJwt, makeFakeUpstream } from "./helpers.ts"
import { API_KEY_NAME } from "../src/constants.ts"

const USER = "13800000000@example.com"

function makeClient() {
  const fake = makeFakeUpstream()
  const client = new EaiChatClient({ fetchImpl: fake.fetchImpl })
  return { fake, client }
}

const digest = (pw: string) => sha256Hex(pw)

test("登录链路成功：IAM → CAS → ticketAuthorize，拿到 sk 与 JWT", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  assert.ok(client.isLoggedIn)
  assert.ok((client.token ?? "").length > 20)
  assert.equal(client.tenant, 103762)
  assert.ok((client.jwtExpiresAt() ?? 0) > Date.now())
  // 登录链路请求数：IAM + CAS + 网关 + ticketAuthorize
  assert.equal(fake.requests.length, 4)
})

test("登录后 portal 接口带 JWT cookie 与可验证的 Web-Signature", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  fake.state.usage = { totalTokens: 800_000, usedTokens: 5_000, expTokens: 1_000, remainTokens: 794_000 }
  const usage = await client.getTokenUsage()
  assert.deepEqual(usage, { totalTokens: 800_000, usedTokens: 5_000, expTokens: 1_000, remainTokens: 794_000 })

  const req = fake.requests.at(-1)!
  assert.ok(req.headers.cookie.includes("YL-Token="))
  assert.match(req.headers["web-signature"], /^[0-9a-f]{64}$/)
  assert.equal(req.headers["web-random"].length, 8)
})

test("JWT 失效（40401）→ UpstreamError.sessionExpired", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  fake.state.jwtValid = false
  await assert.rejects(
    () => client.getTokenUsage(),
    (e: unknown) => e instanceof UpstreamError && e.sessionExpired === true,
  )
  // 会话被清空，后续调用直接按未登录处理
  assert.equal(client.isLoggedIn, false)
})

test("密码错误 → LoginRefusedError（不标记 sessionExpired）", async () => {
  const { client } = makeClient()
  await assert.rejects(
    () => client.login({ userAccount: USER, passwordDigest: digest("wrong-password") }),
    (e: unknown) => e instanceof Error && /账号或密码/.test((e as Error).message),
  )
})

test("任务列表解析：字段归一 + 奖励累加 + 连续天数", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  fake.state.tasks = [
    dailyTask({ pointsList: [{ type: 600, typeDesc: "TOKEN", value: 100_000 }, { type: 601, typeDesc: "BONUS", value: 50_000 }], receiveProgressMap: { a: 1, b: 1, c: 0 } }),
    { taskDefId: 3002, taskDefName: "邀请好友", pointsList: [], currentProgress: 0, canReceive: false },
  ]
  const tasks = await client.getTokenTasks()
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].reward, 150_000)
  assert.equal(tasks[0].checkedDays, 2)
  assert.equal(tasks[0].canReceive, true)
})

test("API Key 列表解析：records 形状 + 字段别名", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  fake.state.keys = [
    { id: "1", name: "手工 Key", apiKey: "sk-manual" },
    { id: "2", name: API_KEY_NAME, apiKey: "sk-plugin" },
  ]
  const rows = await client.listApiKeys()
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r.name === API_KEY_NAME)?.key, "sk-plugin")
})

test("模型清单解析：上游字段归一 + 去重；失败抛 UpstreamError", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  fake.state.models = [
    { id: 1, title: "A", model: "a", api: "openai-completions, anthropic-messages" },
    { id: 2, name: "B", modelId: "b" },
    { id: 3, title: "C", code: "c", api: ["anthropic-messages"] },
    { id: 4, title: "A again", model: "a" },
    { id: 5, title: "no id" },
  ]
  const models = await client.listModels()
  assert.deepEqual(models, [
    { id: "a", name: "A", apis: ["openai-completions", "anthropic-messages"] },
    { id: "b", name: "B", apis: [] },
    { id: "c", name: "C", apis: ["anthropic-messages"] },
  ])

  fake.state.modelsResultCode = -1
  await assert.rejects(
    () => client.listModels(),
    (e: unknown) => e instanceof UpstreamError && /模型列表获取失败/.test((e as Error).message),
  )
})

test("keyOfCreated 兼容多种字段名", () => {
  assert.equal(keyOfCreated({ apiKey: "a" }), "a")
  assert.equal(keyOfCreated({ key: "b" }), "b")
  assert.equal(keyOfCreated({ data: { keySecret: "c" } }), "c")
  assert.equal(keyOfCreated({}), "")
})

test("addApiKey 提交固定名称与空模型数组", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  await client.addApiKey(API_KEY_NAME)
  const req = fake.requests.at(-1)!
  assert.deepEqual(JSON.parse(req.body ?? "{}"), { name: API_KEY_NAME, models: [] })
  assert.equal(fake.counters.addApiKey, 1)
})

test("receivePoints 成功与业务拒绝", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  await client.receivePoints(3001, 0)
  assert.equal(fake.counters.receivePoints, 1)

  fake.state.receiveRefusal = "今日已签到"
  await assert.rejects(() => client.receivePoints(3001, 0), /今日已签到/)
})

test("新 JWT 生效后旧会话按过期处理（模拟续登后的旧客户端）", async () => {
  const { fake, client } = makeClient()
  await client.login({ userAccount: USER, passwordDigest: digest("correct-password") })
  fake.setJwt(fakeJwt(Date.now() + 3600_000))
  await assert.rejects(
    () => client.getTokenUsage(),
    (e: unknown) => e instanceof UpstreamError && e.sessionExpired === true,
  )
})
