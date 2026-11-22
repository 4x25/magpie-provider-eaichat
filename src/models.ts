/**
 * 模型目录：运行期以上游清单为准，按协议生成 OpenCode Model 形状。
 * 上游没有提供上下文/输出/思考档位，这部分仍来自 models.dev 生成的元数据；
 * 未知模型退化为保守默认值。
 */
import { ANTHROPIC_BASE, MODEL_SPECS, OPENAI_BASE } from "./constants.ts"
import { MODEL_METADATA, type Modality, type ModelMetadata } from "./model-metadata.ts"
import type { EaiModel } from "./eaichat.ts"

export type WireProtocol = "anthropic" | "openai"

export interface Wire {
  npm: string
  url: string
}

export const WIRES: Record<WireProtocol, Wire> = {
  anthropic: { npm: "@ai-sdk/anthropic", url: `${ANTHROPIC_BASE}/v1` },
  openai: { npm: "@ai-sdk/openai-compatible", url: OPENAI_BASE },
}

const MODALITIES: readonly Modality[] = ["text", "image", "audio", "video", "pdf"]

/** 上游 `api` 字段里代表两种协议的取值。 */
const PROTOCOL_APIS: Record<WireProtocol, readonly string[]> = {
  openai: ["openai-completions", "openai"],
  anthropic: ["anthropic-messages", "anthropic"],
}

/** 保守默认值：models.dev 没有该上游模型映射时使用。 */
const UNKNOWN_METADATA: ModelMetadata = {
  context: 128_000,
  output: 32_000,
  input: ["text"],
  reasoning: false,
  efforts: [],
  sourceEntries: 0,
}

const SPECS = new Map(MODEL_SPECS.map((model) => [model.id, model]))

type DisplayModel = Pick<EaiModel, "id" | "name">

/** 上游声明了端点时，按声明过滤；没声明（空）视为两种协议都可用。 */
export function supportsProtocol(model: EaiModel, protocol: WireProtocol): boolean {
  if (model.apis.length === 0) return true
  const tokens = PROTOCOL_APIS[protocol]
  return model.apis.some((api) => tokens.includes(api))
}

/** 思考档位写成 OpenCode 的 variants：键是档位名，值是请求参数。 */
function variantsOf(efforts: readonly string[]) {
  if (efforts.length === 0) return undefined
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

function metadataOf(id: string): ModelMetadata {
  const spec = SPECS.get(id)
  const meta = spec ? MODEL_METADATA[spec.canonical] : undefined
  return meta ?? UNKNOWN_METADATA
}

/** 单个模型的声明（config 钩子与 models 钩子共用）。 */
export function modelEntry(model: DisplayModel, wire: Wire) {
  const meta = metadataOf(model.id)
  const input = meta.input
  const reasoning = meta.reasoning
  const variants = variantsOf(meta.efforts)

  return {
    name: model.name,
    api: { id: model.id, url: wire.url, npm: wire.npm },
    limit: { context: meta.context, output: meta.output },
    // OpenCode 1 的字段
    reasoning,
    tool_call: true,
    modalities: { input, output: ["text"] },
    // OpenCode 2 / magpie 的 capabilities 字段
    capabilities: {
      temperature: true,
      reasoning,
      toolcall: true,
      attachment: input.some((kind) => kind !== "text"),
      input: Object.fromEntries(MODALITIES.map((kind) => [kind, input.includes(kind)])),
      output: { text: true },
    },
    ...(variants ? { variants } : {}),
  }
}

/**
 * 全量模型表：只包含上游清单里的模型（并按协议过滤）。
 * 空清单就是空表。
 */
export function modelsFor(
  protocol: WireProtocol,
  upstream: readonly EaiModel[],
): Record<string, ReturnType<typeof modelEntry>> {
  const wire = WIRES[protocol]
  const source: readonly DisplayModel[] = upstream
    .filter((model) => supportsProtocol(model, protocol))
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
    }))
  return Object.fromEntries(source.map((model) => [model.id, modelEntry(model, wire)]))
}
