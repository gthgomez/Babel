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
export type NativeTaskOperation = { tool: string; target: string; completed: boolean; exitCode?: number }
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

/** A settled CLI exit must agree with its canonical terminal outcome. */
export function nativeCliProcessSettled(process: { exitCode: number; timedOut?: boolean; failureCapsule?: unknown }, terminal: NativeTaskTerminal | null): boolean {
  return terminal !== null && process.exitCode === (terminal.status === 'completed' ? 0 : 1) &&
    process.timedOut !== true && process.failureCapsule === undefined
}

/** No evaluator spend/turn/request overrides and no host execution fallback. */
export function runNativeCliTask(input: { root: string; projectRoot: string; runsRoot: string; prompt: string; model?: string }): {
  terminal: NativeTaskTerminal
  operations: NativeTaskOperation[]
  routes: { provider: string | null; model: string | null; requestedModel: string | null; sentModel: string | null }[]
  verifierExitCode: number | null
} {
  if (process.env['BABEL_CLI_ENTRY']?.trim()) throw new Error('native_cli_override_not_admitted')
  if (/[;,]/.test(input.projectRoot)) throw new Error('native_cli_scope_unavailable')
  const cli = runBabelCli(['run', '--mode', 'chat-headless', '--json', '--project-root', input.projectRoot,
    ...(input.model ? ['--model', input.model] : []), input.prompt], {
    projectRoot: input.projectRoot, offlineDemo: false, cwd: join(input.root, 'babel-cli'), ensureDist: 'fail',
    cliEntry: join(input.root, 'babel-cli/dist/index.js'),
    env: { BABEL_ROOT: input.root, BABEL_RUNS_DIR: input.runsRoot,
      BABEL_ALLOWED_ROOTS: input.projectRoot, BABEL_OPENCLAW_APPROVED_ROOTS: input.projectRoot },
  })
  const terminal = parseNativeCliPayload(cli.payload)
  if (!nativeCliProcessSettled(cli, terminal)) throw new Error(`native_cli_process_failed:exit_${cli.exitCode}:timeout_${cli.timedOut === true}`)
  const parsed = PayloadSchema.safeParse(cli.payload)
  if (!terminal || !parsed.success) throw new Error('native_cli_terminal_unavailable')
  const runRelative = relative(input.runsRoot, parsed.data.run_dir)
  if (!runRelative || isAbsolute(runRelative) || runRelative === '..' || runRelative.startsWith(`..${sep}`)) throw new Error('native_cli_session_binding_unavailable')
  const inspected = inspectSessionEventLogFromDir(parsed.data.run_dir)
  if (inspected.kind !== 'valid') throw new Error('native_cli_session_evidence_unavailable')
  const ended = inspected.log.events.filter(event => event.kind === 'turn_ended').at(-1)
  if (!ended || ended.outcome !== terminal.outcome) throw new Error('native_cli_terminal_conflict')
  const operations = inspected.log.events.filter(event => event.kind === 'tool_started').map(event => {
    const settled = inspected.log.events.find(candidate =>
      (candidate.kind === 'tool_completed' || candidate.kind === 'tool_failed' || candidate.kind === 'tool_cancelled') &&
      candidate.seq > event.seq && candidate.turn_id === event.turn_id && candidate.tool_call_id === event.tool_call_id &&
      candidate.idempotency_key === event.idempotency_key && candidate.tool_name === event.tool_name)
    const exitCode = settled && 'exit_code' in settled ? settled.exit_code : undefined
    return { tool: event.tool_name, target: event.target_summary ?? '',
      completed: settled?.kind === 'tool_completed' && (exitCode === undefined || exitCode === 0),
      ...(exitCode !== undefined ? { exitCode } : {}) }
  })
  const inputs = inspected.log.events.filter(event => event.kind === 'model_input_receipt')
  const routes = inspected.log.events.filter(event => event.kind === 'model_result_delivery').map(event => {
    const request = inputs.find(input => input.inference_id === event.inference_id)
    return { provider: event.provider ?? request?.provider ?? null, model: event.observed_model_id ?? event.model ?? null,
      requestedModel: request?.requested_model_id ?? null, sentModel: request?.sent_model_id ?? null }
  })
  const verifier = inspected.log.events.filter(event => event.kind === 'verifier_attempt').filter(event => event.authoritative).at(-1)
  return { terminal, operations, routes, verifierExitCode: verifier?.exit_code ?? null }
}
