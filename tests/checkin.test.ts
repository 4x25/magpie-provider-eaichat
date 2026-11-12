import { strict as assert } from "node:assert"
import { test } from "node:test"
import { claimedOf, planCheckin, planToOutcome, settleAfterRefused } from "../src/checkin.ts"
import type { EaiTokenTask } from "../src/eaichat.ts"

const task = (o: Partial<EaiTokenTask> = {}): EaiTokenTask => ({
  taskDefId: 3001,
  taskDefName: "每日签到",
  currentProgress: 0,
  status: 0,
  canReceive: true,
  reward: 100_000,
  checkedDays: 3,
  ...o,
})

test("可领取：返回 claim 计划（带 progress/奖励/连续天数）", () => {
  const plan = planCheckin([task()])
  assert.deepEqual(plan, { kind: "claim", progress: 0, credit: 100_000, streak: 3 })
})

test("已签到：canReceive=false → done", () => {
  const plan = planCheckin([task({ canReceive: false })])
  assert.equal(plan.kind, "done")
  assert.equal(planToOutcome(plan).outcome, "done")
})

test("无每日任务 → inactive", () => {
  const plan = planCheckin([{ ...task(), taskDefId: 3002 }])
  assert.equal(plan.kind, "inactive")
  assert.equal(planToOutcome(plan).outcome, "inactive")
})

test("claimed 结果带奖励与文案", () => {
  const r = claimedOf(100_000, 5)
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 100_000)
  assert.equal(r.streak, 5)
  assert.match(r.message, /100/)
})

test("领取被拒后复查：已签到 → done；否则 failed", () => {
  const done = settleAfterRefused([task({ canReceive: false })], "重复领取")
  assert.equal(done.outcome, "done")
  const failed = settleAfterRefused([task()], "余额不足")
  assert.equal(failed.outcome, "failed")
  assert.equal(failed.message, "余额不足")
})
