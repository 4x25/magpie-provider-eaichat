/** 签到映射：Token 任务 → magpie checkin 结果。 */
import { DAILY_TASK_ID } from "./constants.ts"
import type { EaiTokenTask } from "./eaichat.ts"

export type CheckinOutcome =
  | { outcome: "claimed"; credit: number; streak: number; message: string }
  | { outcome: "done"; message: string }
  | { outcome: "inactive"; message: string }
  | { outcome: "failed"; message: string }

export type CheckinPlan =
  | { kind: "claim"; progress: number; credit: number; streak: number }
  | { kind: "done" }
  | { kind: "inactive" }

/** 依据任务列表决定签到动作。 */
export function planCheckin(tasks: EaiTokenTask[]): CheckinPlan {
  const daily = tasks.find((t) => t.taskDefId === DAILY_TASK_ID)
  if (!daily) return { kind: "inactive" }
  if (!daily.canReceive) return { kind: "done" }
  return { kind: "claim", progress: daily.currentProgress, credit: daily.reward, streak: daily.checkedDays }
}

export function planToOutcome(plan: Exclude<CheckinPlan, { kind: "claim" }>): CheckinOutcome {
  switch (plan.kind) {
    case "done":
      return { outcome: "done", message: "今日已签到" }
    case "inactive":
      return { outcome: "inactive", message: "每日签到任务未下发（当前可能没有签到活动）" }
  }
}

/** 领取成功后的结果。 */
export function claimedOf(credit: number, streak: number): CheckinOutcome {
  return {
    outcome: "claimed",
    credit,
    streak,
    message: `签到成功，+${credit} tokens（预计 1 分钟内到账）`,
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
