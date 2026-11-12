/** 极简 CookieJar：只处理本插件用到的 name/value/domain/path。 */
import { toTrimmedString } from "./util.ts"

interface Cookie {
  name: string
  value: string
  domain: string
  path: string
}

export class CookieJar {
  private cookies: Cookie[] = []

  addFromResponse(setCookies: string[], requestUrl: string): void {
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(";")
      const eq = pair.indexOf("=")
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) continue
      const attr = (key: string): string | undefined => {
        const hit = attrs.find((item) => item.trim().toLowerCase().startsWith(`${key}=`))
        return hit ? hit.slice(hit.indexOf("=") + 1).trim() : undefined
      }
      const domain = (attr("domain") || new URL(requestUrl).hostname).replace(/^\./, "").toLowerCase()
      const cookiePath = attr("path") || "/"

      let expired = false
      const maxAge = attr("max-age")
      if (maxAge !== undefined && Number(maxAge) <= 0) expired = true
      const expires = attr("expires")
      if (expires && new Date(expires).getTime() <= Date.now()) expired = true

      this.cookies = this.cookies.filter(
        (c) => !(c.name === name && c.domain === domain && c.path === cookiePath),
      )
      if (!expired && value) this.cookies.push({ name, value, domain, path: cookiePath })
    }
  }

  headerFor(url: string): string {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return this.cookies
      .filter(
        (c) =>
          (host === c.domain || host.endsWith(`.${c.domain}`)) && parsed.pathname.startsWith(c.path)
      )
      .map((c) => `${c.name}=${c.value}`)
      .join("; ")
  }

  get(name: string): string | null {
    return this.cookies.find((c) => c.name === name)?.value ?? null
  }

  clear(): void {
    this.cookies = []
  }
}

/** 从 Response 收集 set-cookie（兼容各运行时）。 */
export function setCookiesOf(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie()
  const single = res.headers.get("set-cookie")
  return single ? [single] : []
}

/** 账号显示名脱敏：保留首尾各 2 字符。 */
export function maskAccount(account: string): string {
  const s = toTrimmedString(account)
  if (s.length <= 4) return s ? s[0] + "***" : ""
  if (s.length <= 8) return s.slice(0, 2) + "***" + s.slice(-2)
  return s.slice(0, 3) + "***" + s.slice(-4)
}
