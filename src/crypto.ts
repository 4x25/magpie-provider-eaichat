/** 上游加密/签名原语（node:crypto，无第三方依赖）。 */
import crypto from "node:crypto"

export const md5Hex = (text: string): string =>
  crypto.createHash("md5").update(text, "utf8").digest("hex")

export const sha256Hex = (text: string): string =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex")

export const randomUuid = (): string => crypto.randomUUID()

export const randomHex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex")

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

export function randomAlphaNum(length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += ALNUM[crypto.randomInt(ALNUM.length)]
  return out
}

/** 与网页端一致的 clientKey 生成口径：可打印 ASCII 32..126。 */
export function randomPrintable(length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += String.fromCharCode(32 + crypto.randomInt(95))
  return out
}

function aesEcbAlgorithm(key: string): string {
  const bits = Buffer.byteLength(key, "utf8") * 8
  if (![128, 192, 256].includes(bits)) throw new Error(`不支持的 AES key 长度: ${bits} bit`)
  return `aes-${bits}-ecb`
}

/** AES-ECB / PKCS#7（网关配置、sessionKey；加密侧主要供测试构造假上游）。 */
export function aesEcbEncrypt(plain: string, key: string): string {
  const cipher = crypto.createCipheriv(aesEcbAlgorithm(key), Buffer.from(key, "utf8"), null)
  return Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]).toString("base64")
}

/** AES-ECB / PKCS#7（网关配置、sessionKey）。 */
export function aesEcbDecrypt(cipherBase64: string, key: string): string {
  const decipher = crypto.createDecipheriv(aesEcbAlgorithm(key), Buffer.from(key, "utf8"), null)
  return Buffer.concat([
    decipher.update(Buffer.from(cipherBase64, "base64")),
    decipher.final(),
  ]).toString("utf8")
}

/** RSA PKCS#1 v1.5 私钥解密（测试假上游解 clientKey 用）。 */
export function rsaDecryptPkcs1(privateKeyPem: string, cipher: Buffer): string {
  return crypto
    .privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, cipher)
    .toString("utf8")
}

/** 公钥 SPKI base64 → PEM，PKCS#1 v1.5 加密后 hex。 */
export function rsaEncryptPkcs1Hex(spkiBase64: string, plain: string): string {
  const pem = `-----BEGIN PUBLIC KEY-----\n${spkiBase64}\n-----END PUBLIC KEY-----`
  return crypto
    .publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain, "utf8"))
    .toString("hex")
}

/**
 * 网页 S({params, sk, data}) 签名同构：
 * params 按 key 排序拼 k=v；data 先 MD5；再 SHA256(`${payload}&sk&timestamp&random`)。
 */
export function buildSignature(options: {
  params?: Record<string, unknown>
  dataString?: string
  sk: string
}): { sign: string; random: string; timestamp: string } {
  const query = Object.entries(options.params ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&")

  let payload = query
  if (options.dataString !== undefined) {
    const digest = md5Hex(options.dataString)
    payload = payload ? `${payload}&${digest}` : digest
  }

  const timestamp = Date.now().toString()
  const random = randomAlphaNum(8)
  const toSign = `${payload ? `${payload}&` : ""}${options.sk}&${timestamp}&${random}`
  return { sign: sha256Hex(toSign), random, timestamp }
}

/** base64url 解码 JWT payload（不校验签名）。 */
export function jwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1]
    if (!part) return null
    const json = Buffer.from(part, "base64url").toString("utf8")
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
