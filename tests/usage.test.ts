import { strict as assert } from "node:assert"
import { test } from "node:test"
import { formatTokens, usageOf } from "../src/usage.ts"
import { maskAccount } from "../src/http.ts"

test("usage 窗口：amount/limit 以 已用+剩余 为口径", () => {
  const u = usageOf(
    { totalTokens: 800_000, usedTokens: 200_000, expTokens: 50_000, remainTokens: 550_000 },
    "user@example.com",
  )
  assert.equal(u.plan, "Token 中心")
  const w = u.windows[0]
  assert.equal(w.name, "Token 额度")
  assert.equal(w.amount, 200_000)
  assert.equal(w.limit, 750_000) // 已用 + 剩余
  assert.equal(w.unit, "tokens")
  assert.match(w.display, /已用 20 万/)
  assert.match(w.display, /剩余 55 万/)
  assert.match(w.display, /已过期 5 万/)
  assert.equal(w.runsOut, 50_000)
})

test("无过期额度时不带 runsOut 字段", () => {
  const u = usageOf({ totalTokens: 1000, usedTokens: 100, expTokens: 0, remainTokens: 900 }, "u@x.com")
  assert.equal(u.windows[0].runsOut, undefined)
  assert.doesNotMatch(u.windows[0].display, /已过期/)
})

test("formatTokens 保精度", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(10_000), "1 万")
  assert.equal(formatTokens(123_456), "12.35 万")
  assert.equal(formatTokens(800_000), "80 万")
  assert.equal(formatTokens(123_456_789), "1.23 亿")
})

test("账号名脱敏", () => {
  assert.equal(maskAccount("ab"), "a***")
  assert.equal(maskAccount("abcd"), "a***")
  assert.equal(maskAccount("abcde"), "ab***de")
  assert.equal(maskAccount("13800000000@example.com"), "138***.com")
})
