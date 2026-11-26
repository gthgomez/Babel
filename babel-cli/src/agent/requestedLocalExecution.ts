import { resolve } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { BlockedReport } from '../schemas/agentContracts.js'
import { parseCommandArgv } from '../utils/commandArgv.js'
import { redactSecrets } from '../utils/redaction.js'
import type { ChatToolAction } from './chatToolDefinitions.js'
import type { TaskContractProvenanceRecord } from './taskContract.js'

const REF_PREFIX = 'babel:requested-local-execution:v1'
const DENIAL_PREFIX = 'required_local_execution_denied'
const EXACT_RUN = /^(?:please\s+)?(?:run|execute)\s+`([^`]+)`$/i
const RESTRICTED_RUN = /\b(?:do\s+not|don['’]t|never|skip|avoid|without)\s+(?:[a-z]+\s+){0,2}(?:run|execute|running|executing)\b/i
const EXAMPLE_FRAME = /^(?:for example|an? example|example|sample|illustration|logs?|quoted text)(?:\s*:|\s*$)/i
const SCRIPT_PATH = String.raw`(?:\./)?[\p{L}\p{N}_-][\p{L}\p{N}_.\/-]*\.(?:py|[cm]?js)`
const FILE_PATH = String.raw`(?:\./)?[\p{L}\p{N}_-][\p{L}\p{N}_.\/-]*`
const DECLARED_SCRIPT = new RegExp(String.raw`^(?:please\s+)?(?:add|create|write)\s+\x60?(${SCRIPT_PATH})\x60?(?=$|[\s,])`, 'iu')
const LOCAL_JOB = new RegExp(String.raw`^(?:please\s+)?(?:run|execute)\s+(?:the exporter|\x60?(${SCRIPT_PATH})\x60?)\s+to\s+(?:create|generate)\s+\x60?(${FILE_PATH})\x60?\s+from\s+\x60?(${FILE_PATH})\x60?(?:\s+and\s+leave\s+both\b[^.;]*)?$`, 'iu')

type LocalRun = Extract<ChatToolAction, { type: 'run_command' | 'test_run' }>
type ExecutionScope = 'standalone' | 'mixed'
export type MissingLocalExecutionAuthority = 'no_lease' | 'missing_capability' | 'unresolved'

function argvForLocalOperation(command: string): string[] | null {
  // This matcher identifies a single process request. Shell constructs and
  // expansions are intentionally outside its meaning; policy still owns them.
  if (/[;&|<>$`%^!\r\n\0]/.test(command)) return null
  try {
    const argv = parseCommandArgv(command)
    return argv[0] && !argv[0].includes('=') ? argv : null
  } catch {
    return null
  }
}

function executionRef(scope: ExecutionScope, argv: readonly string[]): string {
  return `${REF_PREFIX}:${scope}:${sha256Canonical({ argv, cwd: '.' })}`
}

function activeClauses(activeProse: readonly string[]): string[] {
  return activeProse.flatMap(line => {
    const cleaned = line.trim()
      .replace(/^(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^(?:acceptance criteria|requirements?)\s*:\s*/i, '')
    // Split only outside code spans; quoted argv can contain punctuation.
    return cleaned.split(/(`[^`]*`)/g).reduce<string[]>((clauses, piece, index) => {
      if (index % 2 === 1) {
        clauses[clauses.length - 1] += piece
      } else {
        const [start, ...rest] = piece.split(/[.!?](?=\s|$)|;/)
        clauses[clauses.length - 1] += start ?? ''
        clauses.push(...rest)
      }
      return clauses
    }, ['']).map(clause => clause.trim()).filter(Boolean)
  })
}

function jobArgv(clause: string, declaredScripts: readonly string[]): string[][] {
  const job = LOCAL_JOB.exec(clause)
  if (!job || /\b(?:if|unless|when|optional)\b/i.test(clause)) return []
  const script = job[1] ?? (declaredScripts.length === 1 ? declaredScripts[0] : undefined)
  if (!script || [script, job[2], job[3]].some(path => path?.split('/').includes('..'))) return []
  const executables = /\.py$/i.test(script) ? ['python3', 'python'] : ['node']
  return executables.map(executable => [executable, script, job[3]!, job[2]!])
}

function jobScope(clauses: readonly string[], index: number, argv: readonly string[]): ExecutionScope {
  if (clauses.length === 1) return 'standalone'
  // The declared script and its generated output form one deliverable. Only
  // the narrow single-job frame can settle early; independent instructions
  // before or after it keep the rest of the task moving.
  if (DECLARED_SCRIPT.exec(clauses[0] ?? '')?.[1] !== argv[1]) return 'mixed'
  if (!clauses.slice(1, index).every(clause => /^(?:it should|use|keep)\b/i.test(clause))) return 'mixed'
  return clauses.slice(index + 1).every(clause =>
    /^(?:show|report) (?:the )?verification(?: you performed)?$/i.test(clause) ||
    clause === `Leave ${argv[2]} unchanged`,
  ) ? 'standalone' : 'mixed'
}

/** Freeze conservative, root-relative operation identities without retaining argv or granting execution authority. */
export function requestedLocalExecutionRefs(activeProse: readonly string[]): TaskContractProvenanceRecord[] {
  const clauses = activeClauses(activeProse)
  if (clauses.some(clause => EXAMPLE_FRAME.test(clause) || RESTRICTED_RUN.test(clause.replace(/`[^`]*`/g, '')))) return []
  const declaredScripts = [...new Set(clauses.flatMap(clause => DECLARED_SCRIPT.exec(clause)?.[1] ?? []))]
  const refs = new Set<string>()
  for (const [index, clause] of clauses.entries()) {
    const command = EXACT_RUN.exec(clause)?.[1]
    const exactArgv = command ? argvForLocalOperation(command) : null
    if (exactArgv) refs.add(executionRef(clauses.length === 1 ? 'standalone' : 'mixed', exactArgv))
    for (const argv of jobArgv(clause, declaredScripts)) refs.add(executionRef(jobScope(clauses, index, argv), argv))
  }
  return [...refs].map(ref => ({ kind: 'derived_acceptance', ref }))
}

/** Match a foreground proposal to an admission-time operation identity, for settlement only. */
export function requiredLocalExecutionScope(
  records: readonly TaskContractProvenanceRecord[],
  action: LocalRun,
  projectRoot: string,
): ExecutionScope | null {
  if (action.type === 'run_command' && (action.background || action.detached)) return null
  if (resolve(projectRoot, action.cwd ?? '.') !== resolve(projectRoot)) return null
  const argv = argvForLocalOperation(action.command)
  if (!argv) return null
  const mixedRef = executionRef('mixed', argv)
  const standaloneRef = executionRef('standalone', argv)
  return records.some(record => record.kind === 'derived_acceptance' && record.ref === mixedRef) ? 'mixed'
    : records.some(record => record.kind === 'derived_acceptance' && record.ref === standaloneRef) ? 'standalone'
    : null
}

/** The executor marks only a typed hard denial with host-confirmed zero dispatch. */
export function requiredLocalExecutionDenialMarker(
  scope: ExecutionScope,
  authority: MissingLocalExecutionAuthority,
): string {
  return `${DENIAL_PREFIX}:${scope}:${authority}`
}

function authorityExplanation(authority: string): string {
  if (authority === 'no_lease') return 'The session has no execution lease.'
  if (authority === 'missing_capability') return 'The session lease does not include the required execution capability.'
  return 'The session lacks the required execution authority; the lease cause was not established.'
}

interface ExecutionLogRow {
  tool: string
  target: string
  detail?: string | undefined
  working_directory?: string | undefined
  preDispatchNoEffect?: true | undefined
  processExecuted?: boolean | undefined
}

/** Report a remaining hard denial after its batch, or at completion after independent work. */
export function requiredLocalExecutionBlock(
  log: readonly ExecutionLogRow[],
  options: { final: boolean },
): { answer: string; blockedReport: BlockedReport } | null {
  const rows = log.filter(row => row.tool === 'run_command' || row.tool === 'test_run')
  const outstanding = rows.filter(row => row.preDispatchNoEffect === true && row.detail?.startsWith(`${DENIAL_PREFIX}:`)).reverse()
  const blocked = outstanding.find(row => {
    const argv = argvForLocalOperation(row.target)
    if (!argv || (!options.final && !row.detail?.startsWith(`${DENIAL_PREFIX}:standalone:`))) return false
    const ref = executionRef('mixed', argv)
    return !rows.some(other => {
      if (!other.processExecuted || other.working_directory !== row.working_directory ||
          other.detail?.startsWith('background started ')) return false
      const performedArgv = argvForLocalOperation(other.target)
      return performedArgv !== null && executionRef('mixed', performedArgv) === ref
    })
  })
  if (!blocked) return null

  const target = redactSecrets(blocked.target).replace(/[\r\n\t]+/g, ' ').slice(0, 240)
  const cause = authorityExplanation(blocked.detail?.split(':').at(-1) ?? '')
  const reason = `DENY_MISSING_AUTHORITY: ${cause}`
  const missing = `Required foreground command still to run: ${target}`
  return {
    answer: `Babel denied the required command before dispatch: \`${target}\`. ${cause} No process started for this attempt, and this denial was ineligible for approval. The command remains to be run in an environment authorized for it.`,
    blockedReport: {
      schema_version: 1,
      status: 'BLOCKED',
      reason,
      reason_code: 'permission_denied',
      cause_class: 'harness',
      missing,
      checked: [{ action: blocked.tool, target, finding: `${reason} No process started.` }],
    },
  }
}
