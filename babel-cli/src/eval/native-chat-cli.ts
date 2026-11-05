/** Use the production CLI preparation/credential/budget path for live candidates. */
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { statusForOutcome } from '../agent/chatFailureClassification.js'
import { inspectSessionEventLogFromDir } from '../agent/sessionEvents.js'
import type { ChatResult } from '../agent/chatEngine.js'
import { runBabelCli } from '../services/liteTrustDemo.js'

export type NativeTaskTerminal = Pick<ChatResult, 'status' | 'outcome' | 'answer'> & {
  usage?: { [K in keyof ChatResult['usage']]?: ChatResult['usage'][K] | undefined }
  verifierReceipt?: ChatResult['verifierReceipt']
  turnRouting?: unknown[]
}
const PayloadSchema = z.object({
  terminal_outcome: z.enum(['VERIFIED_COMPLETE', 'UNVERIFIED_PATCH', 'BLOCKED_EXTERNAL', 'BLOCKED_POLICY', 'BUDGET_EXHAUSTED', 'CANCELLED', 'INFRA_FAILURE', 'AGENT_FAILURE', 'NO_CHANGE_REQUIRED', 'INVALID_TASK', 'NEEDS_HUMAN_DECISION']),
  answer: z.union([z.string(), z.object({ answer: z.string() }).passthrough()]),
  run_dir: z.string().min(1),
  usage: z.object({
    totalInputTokens: z.number().finite().nonnegative().optional(), totalOutputTokens: z.number().finite().nonnegative().optional(),
    completeCostUSD: z.number().finite().nonnegative().nullable().optional(), costComplete: z.boolean().optional(),
    actualCostUSD: z.number().finite().nonnegative().nullable().optional(), estimatedCostUSD: z.number().finite().nonnegative().optional(),
    reportedCostUSD: z.number().finite().nonnegative().optional(),
    usageComplete: z.boolean().optional(),
  }).passthrough().optional(),
  turnRouting: z.array(z.unknown()).optional(),
}).passthrough()

/** Missing or conflicting host terminal evidence never becomes a completion. */
export function parseNativeCliPayload(payload: unknown): NativeTaskTerminal | null {
  const parsed = PayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const wire = parsed.data
  return {
    status: statusForOutcome(wire.terminal_outcome), outcome: wire.terminal_outcome,
    answer: typeof wire.answer === 'string' ? wire.answer : wire.answer.answer,
    ...(wire.usage ? { usage: wire.usage } : {}), ...(wire.turnRouting ? { turnRouting: wire.turnRouting } : {}),
  }
}

/** A terminal JSON card cannot override a failed or interrupted CLI process. */
export function nativeCliProcessSucceeded(process: { exitCode: number; timedOut?: boolean; failureCapsule?: unknown }): boolean {
  return process.exitCode === 0 && process.timedOut !== true && process.failureCapsule === undefined
}

/** No evaluator spend/turn/request overrides and no host execution fallback. */
export function runNativeCliTask(input: { root: string; projectRoot: string; runsRoot: string; prompt: string; model?: string }): {
  terminal: NativeTaskTerminal
  operations: { tool: string; target: string; exitCode?: number }[]
  routes: { provider: string | null; model: string | null; requestedModel: string | null; sentModel: string | null }[]
  verifierExitCode: number | null
} {
  if (process.env['BABEL_CLI_ENTRY']?.trim()) throw new Error('native_cli_override_not_admitted')
  const cli = runBabelCli(['run', '--mode', 'chat-headless', '--json', '--project-root', input.projectRoot,
    ...(input.model ? ['--model', input.model] : []), input.prompt], {
    projectRoot: input.projectRoot, offlineDemo: false, cwd: join(input.root, 'babel-cli'), ensureDist: 'fail',
    cliEntry: join(input.root, 'babel-cli/dist/index.js'),
    env: { BABEL_ROOT: input.root, BABEL_RUNS_DIR: input.runsRoot },
  })
  if (!nativeCliProcessSucceeded(cli)) throw new Error(`native_cli_process_failed:exit_${cli.exitCode}:timeout_${cli.timedOut === true}`)
  const terminal = parseNativeCliPayload(cli.payload)
  const parsed = PayloadSchema.safeParse(cli.payload)
  if (!terminal || !parsed.success) throw new Error('native_cli_terminal_unavailable')
  const runRelative = relative(input.runsRoot, parsed.data.run_dir)
  if (!runRelative || isAbsolute(runRelative) || runRelative === '..' || runRelative.startsWith(`..${sep}`)) throw new Error('native_cli_session_binding_unavailable')
  const inspected = inspectSessionEventLogFromDir(parsed.data.run_dir)
  if (inspected.kind !== 'valid') throw new Error('native_cli_session_evidence_unavailable')
  const ended = inspected.log.events.filter(event => event.kind === 'turn_ended').at(-1)
  if (!ended || ended.outcome !== terminal.outcome) throw new Error('native_cli_terminal_conflict')
  const operations = inspected.log.events.filter(event => event.kind === 'tool_started').map(event => ({ tool: event.tool_name, target: event.target_summary ?? '' }))
  const inputs = inspected.log.events.filter(event => event.kind === 'model_input_receipt')
  const routes = inspected.log.events.filter(event => event.kind === 'model_result_delivery').map(event => {
    const request = inputs.find(input => input.inference_id === event.inference_id)
    return { provider: event.provider ?? request?.provider ?? null, model: event.observed_model_id ?? event.model ?? null,
      requestedModel: request?.requested_model_id ?? null, sentModel: request?.sent_model_id ?? null }
  })
  const verifier = inspected.log.events.filter(event => event.kind === 'verifier_attempt').filter(event => event.authoritative).at(-1)
  return { terminal, operations, routes, verifierExitCode: verifier?.exit_code ?? null }
}
