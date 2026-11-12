/** 云智助手（eaichat.ctyun.cn）常量。 */

export const PROVIDER_ID = "eaichat"

/** 插件自动创建/复用的 API Key 名称（与用户要求一致，固定值）。 */
export const API_KEY_NAME = "magpie-provider-eaichat"

export const EAI_BASE = "https://eaichat.ctyun.cn"
export const DESK_BASE = "https://desk.ctyun.cn"
export const GATEWAY_URL = "https://gwyilian.ctyun.cn/server/eaiSysInfo"

/** 网关配置 AES-ECB 解密密钥（网页端内置）。 */
export const GATEWAY_AES_KEY = "chinatelecom@cnn"

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"

/** 网页 x-eai-version / YL-Main-Version（2026-11 在网页束中为 202060605）。 */
export const EAI_VERSION = "202060605"
export const PRODUCT_ID = "5"
export const WEB_CLIENT = "eaiapp"

export const HEADERS = {
  userAgent: UA,
  acceptJson: "application/json, text/plain, */*",
} as const

/** 单个上游请求超时。 */
export const CALL_TIMEOUT_MS = 20_000
/** 整条登录链路的总预算。 */
export const LOGIN_BUDGET_MS = 45_000

/** JWT cookie 名。 */
export const JWT_COOKIE = "YL-Token"

/** 用量读取的进程内缓存时长。 */
export const USAGE_TTL_MS = 30_000

/** 每日签到任务 taskDefId（网页「每日签到」）。 */
export const DAILY_TASK_ID = 3001
/** Token 任务列表 displayTypes 过滤值。 */
export const TOKEN_TASK_DISPLAY_TYPE = 5
/**
 * 上游模型 id → 展示信息。
 * 上下文/输出上限按各家族公版取保守值（128K 上下文 / 8K 输出）；
 * 说明见 README：联调后如与 `/platform/cp/models` 不符再校准。
 */
export interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
}

export const MODEL_IDS: ModelInfo[] = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek v4.1 Flash", reasoning: true },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: true },
  { id: "deepseek-v4-flash-0731-oc", name: "DeepSeek v4 Flash (0731 OC)", reasoning: true },
  { id: "deepseek-v4-pro-0813-oc", name: "DeepSeek v4 Pro (0813 OC)", reasoning: true },
  { id: "glm-5.3-oc", name: "GLM 5.3 OC", reasoning: true },
  { id: "qwen-3.8-flash", name: "Qwen 3.8 Flash", reasoning: true },
]

/** Anthropic Messages 基地址（不含 /v1，网关会补 /v1/messages）。 */
export const ANTHROPIC_BASE = "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic"
/** OpenAI Chat Completions 基地址（网关拼 /chat/completions）。 */
export const OPENAI_BASE = "https://eaichat.ctyun.cn/ai/platform/v2/cp"

export const DEFAULT_CONTEXT = 128_000
export const DEFAULT_OUTPUT = 8_192
