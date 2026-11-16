/** 模型目录：6 个上游模型，按协议生成 OpenCode Model 形状。 */
import { ANTHROPIC_BASE, DEFAULT_OUTPUT, MODEL_IDS, OPENAI_BASE, type ModelInfo } from "./constants.ts"

export type WireProtocol = "anthropic" | "openai"

export interface Wire {
  npm: string
  url: string
}

export const WIRES: Record<WireProtocol, Wire> = {
  anthropic: { npm: "@ai-sdk/anthropic", url: `${ANTHROPIC_BASE}/v1` },
  openai: { npm: "@ai-sdk/openai-compatible", url: OPENAI_BASE },
}

/** 单个模型的声明（config 钩子与 models 钩子共用）。 */
export function modelEntry(model: ModelInfo, wire: Wire) {
  return {
    name: model.name,
    api: { id: model.id, url: wire.url, npm: wire.npm },
    limit: { context: model.context, output: DEFAULT_OUTPUT },
    reasoning: model.reasoning,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  }
}

/** 全量模型表。 */
export function modelsFor(protocol: WireProtocol): Record<string, ReturnType<typeof modelEntry>> {
  const wire = WIRES[protocol]
  return Object.fromEntries(MODEL_IDS.map((m) => [m.id, modelEntry(m, wire)]))
}
