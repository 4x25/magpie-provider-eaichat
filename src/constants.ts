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

/** 上游模型列表的进程内缓存时长。 */
export const MODELS_TTL_MS = 60_000

/** 每日签到任务 taskDefId（网页「每日签到」）。 */
export const DAILY_TASK_ID = 3001
/** 连续 7 天签到奖励任务 taskDefId（网页「连续7天签到」；领取后 canReceive 仍可能为 true）。 */
export const STREAK_TASK_ID = 3002
/** Token 任务列表 displayTypes 过滤值。 */
export const TOKEN_TASK_DISPLAY_TYPE = 5
/**
 * 已知上游模型 → models.dev 规范模型 id。
 *
 * 只用于把上游清单里的模型对上 models.dev 元数据（上下文、最大输出、
 * 多模态与思考档位），**不是**模型清单：对外提供的模型列表完全来自
 * 上游 `/platform/cp/models`。新增映射后运行 `npm run update:models`。
 */
export interface ModelSpec {
  id: string
  /** models.dev 的 `canonical_model_id`（如 deepseek/deepseek-v4.1-flash）。 */
  canonical: string
}

export const MODEL_SPECS: ModelSpec[] = [
  { id: "deepseek-v4.1-flash", canonical: "deepseek/deepseek-v4.1-flash" },
  { id: "glm-5.3-flash", canonical: "zhipuai/glm-5.3-flash" },
  { id: "deepseek-v4-pro-0813-oc", canonical: "deepseek/deepseek-v4-pro-0813" },
  { id: "glm-5.3-oc", canonical: "zhipuai/glm-5.3" },
  { id: "qwen-3.8-flash", canonical: "alibaba/qwen3.8-flash" },
]

/** Anthropic Messages 基地址（不含 /v1，网关会补 /v1/messages）。 */
export const ANTHROPIC_BASE = "https://eaichat.ctyun.cn/ai/platform/v2/cp/anthropic"
/** OpenAI Chat Completions 基地址（网关拼 /chat/completions）。 */
export const OPENAI_BASE = "https://eaichat.ctyun.cn/ai/platform/v2/cp"
