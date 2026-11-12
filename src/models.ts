/** 模型目录：6 个上游模型，按协议生成 OpenCode Model 形状。 */
import { ANTHROPIC_BASE, DEFAULT_CONTEXT, DEFAULT_OUTPUT, MODEL_IDS, OPENAI_BASE } from "./constants.ts"

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
export function modelEntry(id: string, name: string, reasoning: boolean, wire: Wire) {
  return {
    name,
    api: { id, url: wire.url, npm: wire.npm },
    limit: { context: DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
    reasoning,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  }
}

/** 全量模型表。 */
export function modelsFor(protocol: WireProtocol): Record<string, ReturnType<typeof modelEntry>> {
  const wire = WIRES[protocol]
  return Object.fromEntries(MODEL_IDS.map((m) => [m.id, modelEntry(m.id, m.name, m.reasoning, wire)]))
}
