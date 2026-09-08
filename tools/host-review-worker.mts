// One controller-owned, text-only review execution. The caller owns Git input
// collection, secret scanning, campaign budget accounting and GitHub publication.
// Run with: node babel-cli/node_modules/tsx/dist/cli.mjs tools/host-review-worker.mts
// --model=<canonical-id> --budget-usd=<ceiling> --prior-reserved-usd=<ledger-total>
// JSON HostReviewWorkerTextInput arrives on stdin; no candidate code is executed.
import { randomUUID } from 'node:crypto'
import { z } from '../babel-cli/node_modules/zod/index.js'
import { OpenCodeGoApiRunner, OpenCodeGoError, isOpenCodeGoModel } from '../babel-cli/src/runners/openCodeGoApi.js'
import { createHostReviewController } from '../babel-cli/src/services/hostReviewController.js'
import { createHostReviewWorker } from '../babel-cli/src/services/hostReviewWorker.js'
import { OpenCodeGoCredentialError } from '../babel-cli/src/runners/openCodeGoCredential.js'

// Keep enough room for a complete ordinary multi-file PR, its task contract,
// and JSON framing. The controller reserves against this full byte ceiling
// before each request, so a larger bounded cap cannot overspend the campaign.
const MAX_INPUT_BYTES = 320 * 1024
const MAX_OUTPUT_TOKENS = 4_096
// Peak published OpenCode Go prices per 1M tokens, checked 2026-09-08:
// https://opencode.ai/docs/go/ . The byte-per-token estimate is deliberately
// more conservative than a tokenizer estimate. This makes the reservation a
// real upper bound for the bounded request without charging every model at an
// unrelated arbitrary maximum rate.
const MODEL_PRICES: Record<string, Readonly<{ input: number; output: number }>> = {
  'deepseek-v4-flash': { input: 0.44, output: 1.32 },
  'mimo-v2.5': { input: 0.14, output: 0.28 },
  'longcat-2.0': { input: 0.30, output: 1.20 },
}
const canonical = z.string().regex(/^[0-9a-f]{40}$/)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const scope = z.array(z.string().min(1)).min(1)
const candidate = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pr_number: z.number().int().positive(), task_id: z.string().min(1), task_hash: digest,
  base_sha: canonical, head_sha: canonical, builder_id: z.string().min(1),
  diff_numstat_digest: digest, scope,
}).strict()

function reservationFor(model: string): number {
  const price = MODEL_PRICES[model]
  if (!price) throw new Error('INVALID_MODEL')
  return ((MAX_INPUT_BYTES + 2_048) * price.input + MAX_OUTPUT_TOKENS * price.output) / 1_000_000
}
const inputSchema = z.object({
  candidate, task_text: z.string().min(1), diff_text: z.string().min(1),
  diff_numstat: z.array(z.string().min(1)).min(1), scope,
}).strict()

async function main(): Promise<void> {
  const args = new Map<string, string>()
  for (const arg of process.argv.slice(2)) {
    const match = /^--(model|budget-usd|prior-reserved-usd|controller-run-id|preflight)=(.+)$/.exec(arg)
    if (!match || args.has(match[1])) throw new Error('INVALID_ARGUMENT')
    args.set(match[1], match[2])
  }
  const model = args.get('model') ?? ''
  if (args.has('preflight') && args.get('preflight') !== 'true') throw new Error('INVALID_PREFLIGHT_ARGUMENT')
  const budget = Number(args.get('budget-usd'))
  const prior = Number(args.get('prior-reserved-usd'))
  if (!isOpenCodeGoModel(model) || !MODEL_PRICES[model]) throw new Error('INVALID_MODEL')
  const reservation = reservationFor(model)
  if (!args.has('budget-usd') || !args.has('prior-reserved-usd') || !Number.isFinite(budget) || budget <= 0 || !Number.isFinite(prior) || prior < 0 || prior + reservation > budget) throw new Error('BUDGET_LIMIT')
  const parts: Buffer[] = []
  let size = 0
  for await (const part of process.stdin) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += buffer.length
    if (size > MAX_INPUT_BYTES) throw new Error('INPUT_BYTE_LIMIT')
    parts.push(buffer)
  }
  const parsed = inputSchema.safeParse(JSON.parse(Buffer.concat(parts).toString('utf8')))
  if (!parsed.success) throw new Error('REVIEW_INPUT_SCHEMA_FAILURE')
  const input = parsed.data
  const executionId = randomUUID()
  const runId = args.get('controller-run-id') ?? randomUUID()
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('INVALID_CONTROLLER_RUN')
  if (args.get('preflight') === 'true') {
    process.stdout.write(JSON.stringify({ status: 'PREFLIGHT_ONLY', model, input_bytes: size, reserved_upper_bound_usd: reservation }) + '\n')
    return
  }
  // Credential resolution happens only after input and budget preflight.
  const runner = new OpenCodeGoApiRunner(model, { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 }, { sessionId: executionId, requestTimeoutMs: 120_000 })
  const adapter = createHostReviewWorker({
    runner, text_input: input, reviewer_id: 'babel-readonly-' + model + '-' + executionId,
    max_input_bytes: MAX_INPUT_BYTES, max_output_bytes: 32_768, timeout_ms: 125_000,
  })
  let idIndex = 0
  const controller = createHostReviewController({
    controller_id: 'babel-host-review', adapter,
    create_id: () => idIndex++ === 0 ? runId : executionId,
  })
  const handoff = await controller.review(input.candidate)
  const metadata = runner.getLastInvocationMetadata()
  process.stdout.write(JSON.stringify({
    status: 'REVIEW_COMPLETED', handoff, requested_model: model,
    observed_model: metadata?.observed_model_id, provider: metadata?.provider,
    usage: { input_tokens: metadata?.prompt_tokens, output_tokens: metadata?.completion_tokens },
    reserved_upper_bound_usd: reservation,
  }) + '\n')
}
main().catch((error: unknown) => {
  // Never dump raw provider errors, helper output, payloads or model text.
  // A small allowlisted category is enough for autonomous repair and does not
  // disclose request or credential material.
  const code = error instanceof OpenCodeGoError || error instanceof OpenCodeGoCredentialError
    ? error.code
    : error instanceof SyntaxError
      ? 'REVIEW_INPUT_JSON_INVALID'
    : error instanceof Error && error.name === 'ZodError'
      ? 'REVIEW_OUTPUT_SCHEMA_FAILURE'
      : error instanceof Error && [
          'INPUT_BYTE_LIMIT',
          'OUTPUT_BYTE_LIMIT',
          'INVALID_ARGUMENT',
          'INVALID_MODEL',
          'INVALID_PREFLIGHT_ARGUMENT',
          'BUDGET_LIMIT',
          'REVIEW_INPUT_SCHEMA_FAILURE',
          'INVALID_CONTROLLER_RUN',
        ].includes(error.message)
        ? error.message
        : 'REVIEW_EXECUTION_FAILURE'
  process.stderr.write(`HOST_REVIEW_FAILED:${code}; no fallback or approval evidence emitted\n`)
  process.exitCode = 1
})
