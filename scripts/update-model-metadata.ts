/**
 * 从 models.dev 生成 `src/model-metadata.ts`。
 *
 * models.dev 没有 eaichat（云智助手）这个供应商，但每个上游模型都有对应的
 * `canonical_model_id`。本脚本按该 id 汇总各供应商的条目：
 *   - 上下文 / 最大输出：出现次数最多的正值（并列取较大值）；
 *   - 输入模态：出现在至少一半条目中的类型；
 *   - 思考档位：出现次数最多的 reasoning_options 组合，toggle 记为 none。
 *
 * 用法：
 *   npm run update:models
 *   node --experimental-strip-types --no-warnings scripts/update-model-metadata.ts --input /path/to/models-dev.json
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { MODEL_SPECS } from "../src/constants.ts"

const MODELS_DEV_URL = "https://models.dev/api.json"
const OUTPUT = resolve(import.meta.dirname, "../src/model-metadata.ts")

const MODALITIES = ["text", "image", "audio", "video", "pdf"] as const
const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

type Modality = (typeof MODALITIES)[number]
type Json = Record<string, unknown>

interface CatalogModel {
  canonical_model_id?: string
  reasoning?: boolean
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[] }
  reasoning_options?: Array<{ type?: string; values?: string[] }>
}

type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

function argsOf(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const eq = arg.indexOf("=")
    if (eq > 0) out.set(arg.slice(2, eq), arg.slice(eq + 1))
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out.set(arg.slice(2), argv[++i])
    else out.set(arg.slice(2), "true")
  }
  return out
}

async function loadCatalog(): Promise<Catalog> {
  const args = argsOf(process.argv.slice(2))
  const file = args.get("input")
  if (file) {
    return JSON.parse(readFileSync(resolve(file), "utf8")) as Catalog
  }
  const res = await fetch(MODELS_DEV_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`)
  return (await res.json()) as Catalog
}

function rowsFor(catalog: Catalog, canonical: string): CatalogModel[] {
  const rows: CatalogModel[] = []
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models ?? {})) {
      if (model.canonical_model_id === canonical) rows.push(model)
    }
  }
  return rows
}

function positive(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 出现次数最多的正值；并列取较大值；没有则 0。 */
function modeNumber(values: unknown[]): number {
  const counts = new Map<number, number>()
  for (const value of values) {
    const n = positive(value)
    if (n > 0) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

interface Options {
  toggle: boolean
  efforts: string[]
}

/** 出现次数最多的 reasoning_options 组合；并列时取档位更多的。 */
function modeOptions(rows: CatalogModel[]): Options {
  const counts = new Map<string, { count: number; options: Options }>()
  for (const row of rows) {
    const efforts = new Set<string>()
    let toggle = false
    for (const option of row.reasoning_options ?? []) {
      if (option.type === "effort") {
        for (const value of option.values ?? []) {
          if (typeof value === "string" && value.trim()) efforts.add(value.trim())
        }
      } else if (option.type === "toggle") {
        toggle = true
      }
    }
    const sorted = [...efforts].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    const key = `${toggle ? "toggle" : "effort"}:${sorted.join(",")}`
    const found = counts.get(key)
    if (found) found.count++
    else counts.set(key, { count: 1, options: { toggle, efforts: sorted } })
  }
  let best: { count: number; options: Options } | undefined
  for (const candidate of counts.values()) {
    if (
      !best ||
      candidate.count > best.count ||
      (candidate.count === best.count && candidate.options.efforts.length > best.options.efforts.length)
    ) {
      best = candidate
    }
  }
  return best?.options ?? { toggle: false, efforts: [] }
}

function rank(effort: string): number {
  const at = EFFORT_RANK.indexOf(effort)
  return at < 0 ? EFFORT_RANK.length : at
}

function inputModalities(rows: CatalogModel[]): Modality[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const kind of row.modalities?.input ?? []) {
      if (MODALITIES.includes(kind as Modality)) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  }
  const half = rows.length / 2
  return MODALITIES.filter((kind) => kind === "text" || (counts.get(kind) ?? 0) >= half)
}

const catalog = await loadCatalog()
const generated: string[] = []
const summary: Array<[string, number, number, number, string, string]> = []
const list = (values: readonly string[]) => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`

for (const model of MODEL_SPECS) {
  const rows = rowsFor(catalog, model.canonical)
  if (rows.length === 0) throw new Error(`models.dev has no entry for canonical id ${model.canonical}`)

  const options = modeOptions(rows)
  const efforts = new Set(options.efforts)
  if (options.toggle) efforts.add("none")
  const sortedEfforts = [...efforts].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const context = modeNumber(rows.map((row) => row.limit?.context))
  const output = modeNumber(rows.map((row) => row.limit?.output))
  const input = inputModalities(rows)
  const reasoning = rows.some((row) => row.reasoning === true) || sortedEfforts.length > 0

  generated.push(
    [
      `  ${JSON.stringify(model.canonical)}: {`,
      `    context: ${context},`,
      `    output: ${output},`,
      `    input: ${list(input)},`,
      `    reasoning: ${reasoning},`,
      `    efforts: ${list(sortedEfforts)},`,
      `    sourceEntries: ${rows.length},`,
      `  },`,
    ].join("\n"),
  )
  summary.push([model.canonical, context, output, rows.length, input.join("+"), sortedEfforts.join("+") || "-"])
}

const text = `/**
 * Generated by \`npm run update:models\` from https://models.dev/api.json.
 * Source date: ${new Date().toISOString().slice(0, 10)}.
 *
 * models.dev has no eaichat provider: each upstream model is matched to its
 * canonical model id (see MODEL_SPECS in constants.ts) and the values here are
 * aggregated over every provider that lists that canonical model.
 *
 * Do not edit by hand. Run the script instead.
 */

export type Modality = "text" | "image" | "audio" | "video" | "pdf"

export interface ModelMetadata {
  context: number
  output: number
  input: readonly Modality[]
  reasoning: boolean
  efforts: readonly string[]
  /** models.dev entries the values were aggregated from. */
  sourceEntries: number
}

export const MODEL_METADATA: Record<string, ModelMetadata> = {
${generated.join("\n")}
}
`

writeFileSync(OUTPUT, text)
console.log(`wrote ${OUTPUT}`)
for (const [canonical, context, output, entries, input, efforts] of summary) {
  console.log(
    `${canonical.padEnd(38)} ctx=${String(context).padStart(9)} out=${String(output).padStart(7)}` +
      ` entries=${String(entries).padStart(4)} input=${input.padEnd(20)} efforts=${efforts}`,
  )
}
