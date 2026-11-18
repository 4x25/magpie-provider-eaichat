/** 模型目录：6 个上游模型，按协议生成 OpenCode Model 形状。 */
import { ANTHROPIC_BASE, MODEL_IDS, OPENAI_BASE, type ModelInfo } from "./constants.ts"
import { MODEL_METADATA, type Modality } from "./model-metadata.ts"

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

/** 思考档位写成 OpenCode 的 variants：键是档位名，值是请求参数。 */
function variantsOf(efforts: readonly string[]) {
  if (efforts.length === 0) return undefined
  return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
}

/** 单个模型的声明（config 钩子与 models 钩子共用）。 */
export function modelEntry(model: ModelInfo, wire: Wire) {
  const meta = MODEL_METADATA[model.canonical]
  if (!meta) {
    throw new Error(`缺少 ${model.canonical} 的 models.dev 元数据，请运行 npm run update:models`)
  }
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

/** 全量模型表。 */
export function modelsFor(protocol: WireProtocol): Record<string, ReturnType<typeof modelEntry>> {
  const wire = WIRES[protocol]
  return Object.fromEntries(MODEL_IDS.map((m) => [m.id, modelEntry(m, wire)]))
}
