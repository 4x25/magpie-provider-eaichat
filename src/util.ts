/** 通用工具与错误类型。 */

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** 上游错误：code 为上游错误码（HTTP 状态码或业务码），-1 表示网络/未知。 */
export class UpstreamError extends Error {
  readonly code: number
  /** 会话已失效（可自动重登）。 */
  readonly sessionExpired: boolean

  constructor(message: string, options: { code?: number; sessionExpired?: boolean } = {}) {
    super(message)
    this.name = "UpstreamError"
    this.code = options.code ?? -1
    this.sessionExpired = options.sessionExpired ?? false
  }
}

/** 登录被上游拒绝且重登无法解决（验证码/锁定/凭据错误等）。 */
export class LoginRefusedError extends UpstreamError {
  constructor(message: string, code = -1) {
    super(message, { code })
    this.name = "LoginRefusedError"
  }
}
