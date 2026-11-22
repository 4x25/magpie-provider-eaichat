/** 签到流程与结果映射：每日签到 + 连续 7 天奖励。 */
import { DAILY_TASK_ID, STREAK_TASK_ID } from "./constants.ts"
import type { EaiTokenTask } from "./eaichat.ts"
import { LoginRefusedError, errText } from "./util.ts"

export type CheckinOutcome =
  | { outcome: "claimed"; credit: number; streak: number; message: string }
  | { outcome: "done"; message: string }
  | { outcome: "inactive"; message: string }
  | { outcome: "failed"; message: string }

export type CheckinPlan =
  | { kind: "claim"; progress: number; credit: number; streak: number }
  | { kind: "done" }
  | { kind: "inactive" }

export type StreakPlan =
  | { kind: "claim"; progress: number; credit: number; streak: number }
  | { kind: "none" }

/** 任务实例已领取：领取后 status 变为 2。 */
const RECEIVED_STATUS = 2

function streakOf(tasks: EaiTokenTask[]): EaiTokenTask | undefined {
  return tasks.find((t) => t.taskDefId === STREAK_TASK_ID)
}

/**
 * 连续 7 天奖励是否还能领取。
 *
 * 不能只看 canReceive：该任务领取后 canReceive 仍为 true，
 * 此时 status 变为 2（receiveDate 同时有值）。
 */
function streakClaimable(task: EaiTokenTask): boolean {
  return task.canReceive && task.status !== RECEIVED_STATUS
}

/** 依据任务列表决定每日签到动作（每日任务仍以 canReceive 为准）。 */
export function planCheckin(tasks: EaiTokenTask[]): CheckinPlan {
  const daily = tasks.find((t) => t.taskDefId === DAILY_TASK_ID)
  if (!daily) return { kind: "inactive" }
  if (!daily.canReceive) return { kind: "done" }
  return { kind: "claim", progress: daily.currentProgress, credit: daily.reward, streak: daily.checkedDays }
}

/** 依据任务列表决定连续 7 天奖励的领取动作。 */
export function planStreakCheckin(tasks: EaiTokenTask[]): StreakPlan {
  const streak = streakOf(tasks)
  if (!streak || !streakClaimable(streak)) return { kind: "none" }
  // 领取请求的 progress 用任务当前进度；2026-11-21 实测为 7。
  return { kind: "claim", progress: streak.currentProgress, credit: streak.reward, streak: streak.checkedDays }
}

export function planToOutcome(plan: Exclude<CheckinPlan, { kind: "claim" }>): CheckinOutcome {
  switch (plan.kind) {
    case "done":
      return { outcome: "done", message: "今日已签到" }
    case "inactive":
      return { outcome: "inactive", message: "每日签到任务未下发（当前可能没有签到活动）" }
  }
}

/** 领取每日签到成功后的结果。 */
export function claimedOf(credit: number, streak: number): CheckinOutcome {
  return {
    outcome: "claimed",
    credit,
    streak,
    message: `签到成功，+${credit} tokens（预计 1 分钟内到账）`,
  }
}

/** 在已有结果上合并连续 7 天奖励。 */
export function withStreakReward(
  outcome: CheckinOutcome,
  reward: { credit: number; streak: number },
): CheckinOutcome {
  const bonus = `连续7天签到奖励 +${reward.credit} tokens`
  switch (outcome.outcome) {
    case "claimed":
      return {
        outcome: "claimed",
        credit: outcome.credit + reward.credit,
        streak: Math.max(outcome.streak, reward.streak),
        message: `签到成功，+${outcome.credit + reward.credit} tokens（含${bonus}，预计 1 分钟内到账）`,
      }
    case "done":
      return {
        outcome: "claimed",
        credit: reward.credit,
        streak: reward.streak,
        message: `今日已签到；${bonus}，领取成功（预计 1 分钟内到账）`,
      }
    case "inactive":
      return {
        outcome: "claimed",
        credit: reward.credit,
        streak: reward.streak,
        message: `每日签到任务未下发；${bonus}，领取成功（预计 1 分钟内到账）`,
      }
    case "failed":
      // 每日签到仍可重试，不能用 claimed 掩盖失败。
      return {
        outcome: "failed",
        message: `${bonus}，领取成功（预计 1 分钟内到账）；每日签到失败：${outcome.message}`,
      }
  }
}

/** 连续 7 天奖励领取失败时，把原因合并进已有结果。 */
export function withStreakFailure(outcome: CheckinOutcome, why: string): CheckinOutcome {
  switch (outcome.outcome) {
    case "claimed":
      return { ...outcome, message: `${outcome.message}；连续7天签到奖励领取失败：${why}` }
    case "done":
      return { outcome: "failed", message: `今日已签到；连续7天签到奖励领取失败：${why}` }
    case "inactive":
      return { outcome: "failed", message: `每日签到任务未下发；连续7天签到奖励领取失败：${why}` }
    case "failed":
      return { outcome: "failed", message: `${outcome.message}；连续7天签到奖励领取失败：${why}` }
  }
}

/** 领取被拒后（通常为重复签到）再查一次任务列表的判定。 */
export function settleAfterRefused(tasks: EaiTokenTask[], why: string): CheckinOutcome {
  const daily = tasks.find((t) => t.taskDefId === DAILY_TASK_ID)
  if (daily && !daily.canReceive) {
    return { outcome: "done", message: "今日已签到" }
  }
  return { outcome: "failed", message: why }
}

export interface CheckinIo {
  readTasks: () => Promise<EaiTokenTask[]>
  receive: (taskDefId: number, progress: number) => Promise<void>
  log?: (message: string) => void
}

/** 每日签到后复查失败时的重试间隔（出网 DNS 经常抖动）。 */
const RECHECK_DELAY_MS = 500

async function recheckTasks(io: CheckinIo): Promise<EaiTokenTask[]> {
  try {
    return await io.readTasks()
  } catch (first) {
    io.log?.(`连续7天签到奖励状态复查失败，稍后重试（${errText(first)}）`)
    await new Promise((resolve) => setTimeout(resolve, RECHECK_DELAY_MS))
    return await io.readTasks()
  }
}

/**
 * 每日签到的完整流程：领每日奖励 → 复查任务 → 若连续 7 天奖励可领则一并领取。
 *
 * 每日签到会推进任务进度，因此领取成功后必须重新拉一次任务列表，
 * 才能看到「连续7天签到」是否刚变为可领取。
 */
export async function runCheckin(io: CheckinIo): Promise<CheckinOutcome> {
  let tasks = await io.readTasks()
  const plan = planCheckin(tasks)
  let outcome: CheckinOutcome
  let dailyChanged = false

  if (plan.kind === "claim") {
    try {
      await io.receive(DAILY_TASK_ID, plan.progress)
      outcome = claimedOf(plan.credit, plan.streak)
      dailyChanged = true
    } catch (e) {
      if (e instanceof LoginRefusedError) throw e
      const why = errText(e)
      const again = await io.readTasks().catch((readError) => {
        if (readError instanceof LoginRefusedError) throw readError
        return null
      })
      if (again) {
        tasks = again
        outcome = settleAfterRefused(again, why)
      } else {
        outcome = { outcome: "failed", message: why }
      }
    }
  } else {
    outcome = planToOutcome(plan)
  }

  if (dailyChanged) {
    try {
      tasks = await recheckTasks(io)
    } catch (e) {
      io.log?.(`连续7天签到奖励状态复查失败（${errText(e)}）`)
    }
  }

  const streak = planStreakCheckin(tasks)
  if (streak.kind !== "claim") return outcome

  try {
    await io.receive(STREAK_TASK_ID, streak.progress)
    return withStreakReward(outcome, streak)
  } catch (e) {
    if (e instanceof LoginRefusedError) {
      // 每日奖励已经到手时不要因为续登失败把 claimed 丢掉。
      if (outcome.outcome === "claimed") {
        return withStreakFailure(outcome, `${errText(e)}，请重新登录`)
      }
      throw e
    }
    const why = errText(e)
    const after = await io.readTasks().catch((readError) => {
      if (readError instanceof LoginRefusedError) throw readError
      return null
    })
    const afterStreak = after ? streakOf(after) : undefined
    if (afterStreak && !streakClaimable(afterStreak)) {
      // 请求报错但任务已不在可领取状态（多为已领取）：保留每日签到的结果。
      io.log?.(`连续7天签到奖励领取返回错误，但任务已不在可领取状态（${why}）`)
      return outcome
    }
    return withStreakFailure(outcome, why)
  }
}
