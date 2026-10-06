/**
 * Deterministic, offline generator for `config/model-catalog.generated.json`.
 *
 * This script never touches the network. It normalizes a stable fixture of the
 * configured OpenRouter inventory (or an explicit `--input <path>` payload)
 * through the same normalizer the runtime uses, then composes an immutable
 * catalog snapshot. The emitted JSON records its own provenance so the
 * committed artifact can be regenerated and audited.
 *
 * Run from `babel-cli`:
 *   npx tsx scripts/generate_model_catalog.ts
 *   npx tsx scripts/generate_model_catalog.ts --input ./some-models.json
 */
import { readFile, writeFile } from 'node:fs/promises'

import { composeCatalogSnapshot, normalizeCatalog } from '../src/intelligence/catalog-normalize.js'
import {
  OPENROUTER_MODELS_URL,
  type OpenRouterModelEntry,
} from '../src/intelligence/openrouterMetadata.js'

const GENERATOR_VERSION = 1
const GENERATOR_PATH = 'babel-cli/scripts/generate_model_catalog.ts'
const GENERATOR_COMMAND = 'npx tsx scripts/generate_model_catalog.ts (run from babel-cli)'
const OBSERVED_AT = '2026-10-06T00:00:00.000Z'
const OUTPUT_URL = new URL('../../config/model-catalog.generated.json', import.meta.url)

/**
 * Stable fixture taken from the configured inventory in `config/model-policy.json`.
 *
 * Limits are the configured values; pricing and `supported_parameters` are
 * intentionally omitted because they were not verified, never invented.
 */
const STABLE_FIXTURE: readonly OpenRouterModelEntry[] = [
  {
    id: 'z-ai/glm-5.3-flash',
    canonical_slug: 'z-ai/glm-5.3-flash',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    context_length: 1_310_720,
    top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    canonical_slug: 'deepseek/deepseek-v4-flash-0731',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    context_length: 1_310_720,
    top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    canonical_slug: 'deepseek/deepseek-v4-pro',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    context_length: 1_000_000,
    top_provider: { context_length: 1_000_000, max_completion_tokens: 384_000 },
  },
]

/** Provenance block written alongside the snapshot; never part of the snapshot hash. */
export interface CatalogProvenance {
  generatedBy: string
  generatorVersion: number
  source: string
  normalizer: string
  input: string
  observedAt: string
  network: false
  command: string
}

/** Build the serializable generated catalog for a fixed fixture and timestamp. */
export function buildGeneratedCatalog(
  entries: readonly OpenRouterModelEntry[],
  observedAt: string,
  inputLabel: string,
): { _provenance: CatalogProvenance } & ReturnType<typeof composeCatalogSnapshot> {
  const batch = normalizeCatalog({
    sourceId: 'openrouter-catalog',
    status: 'ok',
    completeness: 'complete',
    fetchedAt: observedAt,
    models: entries,
  })
  const snapshot = composeCatalogSnapshot(undefined, batch)
  return {
    _provenance: {
      generatedBy: GENERATOR_PATH,
      generatorVersion: GENERATOR_VERSION,
      source: OPENROUTER_MODELS_URL,
      normalizer: 'normalizeCatalog/composeCatalogSnapshot',
      input: inputLabel,
      observedAt,
      network: false,
      command: GENERATOR_COMMAND,
    },
    ...snapshot,
  }
}

function readEntriesFromInput(raw: string): OpenRouterModelEntry[] {
  const parsed: unknown = JSON.parse(raw)
  if (Array.isArray(parsed)) return parsed as OpenRouterModelEntry[]
  if (parsed && typeof parsed === 'object') {
    const data = (parsed as { data?: unknown }).data
    if (Array.isArray(data)) return data as OpenRouterModelEntry[]
  }
  throw new Error('Catalog input must be a model array or an object with a data array.')
}

async function main(): Promise<void> {
  const inputIndex = process.argv.indexOf('--input')
  const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined
  const entries =
    inputPath === undefined
      ? [...STABLE_FIXTURE]
      : readEntriesFromInput(await readFile(inputPath, 'utf8'))
  const inputLabel = inputPath === undefined ? 'embedded stable fixture' : inputPath

  const output = buildGeneratedCatalog(entries, OBSERVED_AT, inputLabel)
  await writeFile(OUTPUT_URL, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `wrote ${OUTPUT_URL.pathname} revision=${output.revision} providerModels=${output.providerModels.length}\n`,
  )
}

await main()
