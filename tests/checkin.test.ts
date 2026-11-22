import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  claimedOf,
  planCheckin,
  planStreakCheckin,
  planToOutcome,
  runCheckin,
  settleAfterRefused,
  withStreakFailure,
  withStreakReward,
} from "../src/checkin.ts"
import type { EaiTokenTask } from "../src/eaichat.ts"
import { LoginRefusedError } from "../src/util.ts"

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

const streak = (o: Partial<EaiTokenTask> = {}): EaiTokenTask => ({
  taskDefId: 3002,
  taskDefName: "连续7天签到",
  currentProgress: 7,
  status: 1,
  canReceive: true,
  reward: 1_000_000,
  checkedDays: 7,
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

test("每日任务仍以 canReceive 为准：status=2 但 canReceive=true 仍可领取", () => {
  assert.equal(planCheckin([task({ canReceive: true, status: 2 })]).kind, "claim")
})

test("连续7天签到：领取后 canReceive=true 但 status=2 视为已领取", () => {
  assert.equal(planStreakCheckin([streak({ canReceive: true, status: 2 })]).kind, "none")
})

test("无每日任务 → inactive", () => {
  const plan = planCheckin([{ ...task(), taskDefId: 3002 }])
  assert.equal(plan.kind, "inactive")
  assert.equal(planToOutcome(plan).outcome, "inactive")
})

test("连续7天签到：可领取 / 已领取 / 未下发", () => {
  assert.deepEqual(planStreakCheckin([streak()]), {
    kind: "claim",
    progress: 7,
    credit: 1_000_000,
    streak: 7,
  })
  assert.equal(planStreakCheckin([streak({ canReceive: false })]).kind, "none")
  assert.equal(planStreakCheckin([task()]).kind, "none")
})

test("claimed 结果带奖励与文案", () => {
  const r = claimedOf(100_000, 5)
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 100_000)
  assert.equal(r.streak, 5)
  assert.match(r.message, /100/)
})

test("合并连续7天奖励：签到成功 → 奖励累加", () => {
  const r = withStreakReward(claimedOf(100_000, 7), { credit: 1_000_000, streak: 7 })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 1_100_000)
  assert.equal(r.streak, 7)
  assert.match(r.message, /连续7天签到奖励/)
  assert.match(r.message, /1100000/)
})

test("合并连续7天奖励：每日已签到 → 仍报告 claimed", () => {
  const r = withStreakReward({ outcome: "done", message: "今日已签到" }, { credit: 1_000_000, streak: 7 })
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 1_000_000)
  assert.match(r.message, /今日已签到/)
})

test("合并连续7天奖励：每日签到失败 → 仍报告 failed（保留重试语义）", () => {
  const r = withStreakReward(
    { outcome: "failed", message: "网络请求失败" },
    { credit: 1_000_000, streak: 7 },
  )
  assert.equal(r.outcome, "failed")
  assert.match(r.message, /连续7天签到奖励/)
  assert.match(r.message, /每日签到失败/)
})

test("连续7天奖励领取失败：保留已到手的每日奖励", () => {
  const r = withStreakFailure(claimedOf(100_000, 3), "重复领取")
  assert.equal(r.outcome, "claimed")
  assert.equal(r.credit, 100_000)
  assert.match(r.message, /连续7天签到奖励领取失败/)
  assert.match(r.message, /重复领取/)

  const failed = withStreakFailure({ outcome: "done", message: "今日已签到" }, "重复领取")
  assert.equal(failed.outcome, "failed")
})

test("领取被拒后复查：已签到 → done；否则 failed", () => {
  const done = settleAfterRefused([task({ canReceive: false })], "重复领取")
  assert.equal(done.outcome, "done")
  const failed = settleAfterRefused([task()], "余额不足")
  assert.equal(failed.outcome, "failed")
  assert.equal(failed.message, "余额不足")
})

test("runCheckin：每日签到后复查并领取刚达成的连续7天奖励", async () => {
  let tasks = [task(), streak({ canReceive: false, status: 0 })]
  const calls: Array<[number, number]> = []
  const outcome = await runCheckin({
    readTasks: async () => tasks,
    receive: async (taskDefId, progress) => {
      calls.push([taskDefId, progress])
      if (taskDefId === 3001) {
        tasks = [task({ canReceive: false, status: 2 }), streak()]
      } else {
        tasks = [task({ canReceive: false, status: 2 }), streak({ canReceive: true, status: 2 })]
      }
    },
  })

  assert.deepEqual(calls, [
    [3001, 0],
    [3002, 7],
  ])
  assert.equal(outcome.outcome, "claimed")
  assert.equal(outcome.credit, 1_100_000)
  assert.equal(outcome.streak, 7)
})

test("runCheckin：今日已签到时补领连续7天奖励", async () => {
  const calls: Array<[number, number]> = []
  const outcome = await runCheckin({
    readTasks: async () => [task({ canReceive: false, status: 2 }), streak()],
    receive: async (taskDefId, progress) => {
      calls.push([taskDefId, progress])
    },
  })

  assert.deepEqual(calls, [[3002, 7]])
  assert.equal(outcome.outcome, "claimed")
  assert.equal(outcome.credit, 1_000_000)
  assert.equal(outcome.streak, 7)
})

test("runCheckin：连续7天奖励领取后 status=2 → 不重复领取", async () => {
  const calls: Array<[number, number]> = []
  const outcome = await runCheckin({
    readTasks: async () => [
      task({ canReceive: false, status: 2 }),
      streak({ canReceive: true, status: 2 }),
    ],
    receive: async (taskDefId, progress) => {
      calls.push([taskDefId, progress])
    },
  })

  assert.deepEqual(calls, [])
  assert.equal(outcome.outcome, "done")
})

test("runCheckin：连续7天奖励领取被拒 → failed（每日已签到）", async () => {
  const outcome = await runCheckin({
    readTasks: async () => [task({ canReceive: false, status: 2 }), streak()],
    receive: async () => {
      throw new Error("奖励已领取")
    },
  })

  assert.equal(outcome.outcome, "failed")
  assert.match(outcome.message, /连续7天签到奖励领取失败/)
  assert.match(outcome.message, /奖励已领取/)
})

test("runCheckin：签到成功后复查失败 → 保留 claimed 并记录警告", async () => {
  let reads = 0
  const warnings: string[] = []
  const outcome = await runCheckin({
    readTasks: async () => {
      reads++
      if (reads === 1) return [task(), streak({ canReceive: false, status: 0 })]
      throw new Error("网络请求失败")
    },
    receive: async () => {},
    log: (message) => {
      warnings.push(message)
    },
  })

  assert.equal(outcome.outcome, "claimed")
  assert.equal(outcome.credit, 100_000)
  assert.match(warnings[0], /复查失败/)
})

test("runCheckin：每日签到失败但连续7天奖励成功 → failed", async () => {
  const calls: Array<[number, number]> = []
  const outcome = await runCheckin({
    readTasks: async () => [task(), streak()],
    receive: async (taskDefId, progress) => {
      calls.push([taskDefId, progress])
      if (taskDefId === 3001) throw new Error("网络请求失败")
    },
  })

  assert.deepEqual(calls, [
    [3001, 0],
    [3002, 7],
  ])
  assert.equal(outcome.outcome, "failed")
  assert.match(outcome.message, /连续7天签到奖励/)
  assert.match(outcome.message, /每日签到失败/)
})

test("runCheckin：连续7天奖励遇到续登失败 → 保留已到手的每日奖励", async () => {
  let tasks = [task(), streak()]
  const outcome = await runCheckin({
    readTasks: async () => tasks,
    receive: async (taskDefId) => {
      if (taskDefId === 3001) {
        tasks = [task({ canReceive: false, status: 2 }), streak()]
        return
      }
      throw new LoginRefusedError("账号已被锁定", 51020)
    },
  })

  assert.equal(outcome.outcome, "claimed")
  assert.equal(outcome.credit, 100_000)
  assert.match(outcome.message, /请重新登录/)
})

test("runCheckin：连续7天奖励报错但复查已领取 → 保留每日结果", async () => {
  let tasks = [task({ canReceive: false, status: 2 }), streak()]
  const outcome = await runCheckin({
    readTasks: async () => tasks,
    receive: async (taskDefId) => {
      if (taskDefId !== 3002) return
      tasks = [task({ canReceive: false, status: 2 }), streak({ canReceive: true, status: 2 })]
      throw new Error("网络请求失败")
    },
  })

  assert.equal(outcome.outcome, "done")
})

test("runCheckin：连续7天奖励报错且任务消失 → failed", async () => {
  let tasks = [task({ canReceive: false, status: 2 }), streak()]
  const outcome = await runCheckin({
    readTasks: async () => tasks,
    receive: async (taskDefId) => {
      if (taskDefId !== 3002) return
      tasks = [task({ canReceive: false, status: 2 })]
      throw new Error("网络请求失败")
    },
  })

  assert.equal(outcome.outcome, "failed")
  assert.match(outcome.message, /连续7天签到奖励领取失败/)
})

test("runCheckin：签到后复查首次失败会重试一次", async () => {
  let reads = 0
  let tasks = [task(), streak({ canReceive: false, status: 0 })]
  const outcome = await runCheckin({
    readTasks: async () => {
      reads++
      if (reads === 2) throw new Error("网络请求失败")
      return tasks
    },
    receive: async (taskDefId) => {
      if (taskDefId === 3001) {
        tasks = [task({ canReceive: false, status: 2 }), streak()]
      }
    },
  })

  assert.equal(reads, 3)
  assert.equal(outcome.outcome, "claimed")
  assert.equal(outcome.credit, 1_100_000)
})

test("runCheckin：每日签到成功后连续7天奖励领取失败 → 保留 claimed", async () => {
  let tasks = [task(), streak()]
  const outcome = await runCheckin({
    readTasks: async () => tasks,
    receive: async (taskDefId) => {
      if (taskDefId === 3001) {
        tasks = [task({ canReceive: false, status: 2 }), streak()]
        return
      }
      throw new Error("网络请求失败")
    },
  })

  assert.equal(outcome.outcome, "claimed")
  assert.equal(outcome.credit, 100_000)
  assert.match(outcome.message, /连续7天签到奖励领取失败/)
})
