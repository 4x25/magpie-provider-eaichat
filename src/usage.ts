/** 用量映射：EAIChat Token 用量 → magpie usage 形状。 */
import type { EaiTokenUsage } from "./eaichat.ts"
import { maskAccount } from "./http.ts"

/** 保留上游精度的数字格式化（中文单位仅在万/亿量级使用）。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${trim(n / 1e8)} 亿`
  if (abs >= 1e4) return `${trim(n / 1e4)} 万`
  return String(Math.round(n))
}

function trim(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, "")
}

export function usageOf(usage: EaiTokenUsage, account: string) {
  const usableLimit = usage.usedTokens + usage.remainTokens
  const display =
    `已用 ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.totalTokens)} tokens` +
    `（剩余 ${formatTokens(usage.remainTokens)}` +
    (usage.expTokens > 0 ? `，已过期 ${formatTokens(usage.expTokens)}` : "") +
    "）"
  return {
    plan: "Token 中心",
    user: maskAccount(account),
    windows: [
      {
        name: "Token 额度",
        // amount/limit 以「已用 + 剩余」为口径：剩余归零即 100%，与路由判断一致；
        // 已过期额度不参与比例，只在 display 中单独展示。
        amount: usage.usedTokens,
        limit: usableLimit,
        unit: "tokens",
        display,
        ...(usage.expTokens > 0
          ? { runsOut: usage.expTokens, runsOutAt: "" }
          : {}),
      },
    ],
  }
}
