import { strict as assert } from "node:assert"
import { test } from "node:test"
import { AccountSession, asStoredAuth, buildAuth } from "../src/state.ts"
import { EaiChatClient } from "../src/eaichat.ts"
import { sha256Hex } from "../src/crypto.ts"
import { errText, UpstreamError } from "../src/util.ts"
import { dailyTask, fakeJwt, makeFakeUpstream } from "./helpers.ts"
import { API_KEY_NAME } from "../src/constants.ts"

const USER = "13800000000@example.com"

function makeSession() {
  const fake = makeFakeUpstream()
  const saved: unknown[] = []
  const logs: string[] = []
  const session = new AccountSession({
    save: async (body) => {
      saved.push(body)
      return true
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    newClient: () => new EaiChatClient({ fetchImpl: fake.fetchImpl }),
  })
  const auth = buildAuth(USER, sha256Hex("correct-password"))
  return { fake, session, auth, saved, logs }
}

test("ensureClient 登录并把 expires 写回 auth", async () => {
  const { fake, session, auth, saved } = makeSession()
  const client = await session.ensureClient(auth)
  assert.ok(client.isLoggedIn)
  assert.equal(fake.counters.logins, 1)
  assert.equal(saved.length, 1)
  assert.ok((saved[0] as { expires: number }).expires > Date.now())
})

test("并发 ensureClient 只登录一次", async () => {
  const { fake, session, auth } = makeSession()
  await Promise.all([session.ensureClient(auth), session.ensureClient(auth), session.ensureClient(auth)])
  assert.equal(fake.counters.logins, 1)
})

test("ensureApiKey：找到同名 Key 直接复用并保存", async () => {
  const { fake, session, auth, saved } = makeSession()
  fake.state.keys = [{ id: "1", name: API_KEY_NAME, apiKey: "sk-existing" }]
  const client = await session.ensureClient(auth)
  const key = await session.ensureApiKey(auth, client)
  assert.equal(key, "sk-existing")
  assert.equal(fake.counters.addApiKey, 0)
  assert.equal((saved.at(-1) as { apiKey?: string }).apiKey, "sk-existing")
})

test("ensureApiKey：没有同名 Key 时自动创建", async () => {
  const { fake, session, auth, saved } = makeSession()
  fake.state.keys = [{ id: "1", name: "手工 Key", apiKey: "sk-manual" }]
  const client = await session.ensureClient(auth)
  const key = await session.ensureApiKey(auth, client)
  assert.equal(key, "sk-eai-1")
  assert.equal(fake.counters.addApiKey, 1)
  assert.equal((saved.at(-1) as { apiKey?: string }).apiKey, "sk-eai-1")
})

test("ensureApiKey：创建响应不回显时回查列表", async () => {
  const { fake, session, auth } = makeSession()
  fake.state.addKeyEchoes = false
  const client = await session.ensureClient(auth)
  const key = await session.ensureApiKey(auth, client)
  assert.equal(key, "sk-eai-1")
  assert.equal(fake.counters.addApiKey, 1)
})

test("ensureApiKey：并发只解析一次", async () => {
  const { fake, session, auth } = makeSession()
  const client = await session.ensureClient(auth)
  await Promise.all([session.ensureApiKey(auth, client), session.ensureApiKey(auth, client)])
  assert.equal(fake.counters.addApiKey, 1)
})

test("readUsage：会话失效自动重登一次并重试", async () => {
  const { fake, session, auth } = makeSession()
  // 第一次登录成功后立刻换掉 JWT，模拟会话中途失效
  const firstClient = await session.ensureClient(auth)
  assert.ok(firstClient.isLoggedIn)
  fake.setJwt(fakeJwt(Date.now() + 3600_000))
  const usage = await session.readUsage(auth)
  assert.equal(usage.totalTokens, 800_000)
  // 两次登录：初始 + 失效后重登
  assert.equal(fake.counters.logins, 2)
})

test("readUsage：TTL 内不重复请求", async () => {
  const { fake, session, auth } = makeSession()
  await session.readUsage(auth)
  const calls = fake.requests.filter((r) => r.url.includes("usage/summry")).length
  await session.readUsage(auth)
  assert.equal(fake.requests.filter((r) => r.url.includes("usage/summry")).length, calls)
})

test("renew：强制重登并返回新 expires", async () => {
  const { fake, session, auth } = makeSession()
  await session.ensureClient(auth)
  fake.state.keys = [{ id: "1", name: API_KEY_NAME, apiKey: "sk-existing" }]
  const fields = await session.renew(auth)
  assert.equal(fake.counters.logins, 2)
  assert.ok((fields.expires as number) > Date.now())
  assert.equal(fields.apiKey, "sk-existing")
})

test("renew 登录被拒（密码错误）抛 LoginRefused 语义", async () => {
  const { fake, session, auth } = makeSession()
  await session.ensureClient(auth)
  fake.state.iamCode = 51010
  await assert.rejects(
    () => session.renew(auth),
    (e: unknown) => /账号或密码/.test(errText(e)),
  )
})

test("asStoredAuth：字段齐全时还原；缺失时为 null", () => {
  const auth = buildAuth(USER, sha256Hex("pw"), "sk-1")
  const restored = asStoredAuth({ ...auth, expires: 123 })
  assert.equal(restored?.apiKey, "sk-1")
  assert.equal(restored?.expires, 123)
  assert.equal(asStoredAuth({ type: "oauth", access: "x" }), null)
  assert.equal(asStoredAuth(null), null)
})

test("会话失效的错误带 sessionExpired 标记", async () => {
  const { fake, session, auth } = makeSession()
  await session.ensureClient(auth)
  fake.state.jwtValid = false
  // readUsage 会自动重登；这里直接用客户端验证标记
  await assert.rejects(
    () => session.currentClient()!.getTokenUsage(),
    (e: unknown) => e instanceof UpstreamError && e.sessionExpired === true,
  )
})
