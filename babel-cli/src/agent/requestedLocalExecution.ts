import { resolve } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { BlockedReport } from '../schemas/agentContracts.js'
import { parseCommandArgv } from '../utils/commandArgv.js'
import { redactSecrets } from '../utils/redaction.js'
import type { ChatToolAction } from './chatToolDefinitions.js'
import type { AcceptanceRequirementV1, TaskContractProvenanceRecord } from './taskContract.js'

const REF_PREFIX = 'babel:requested-local-execution'
const DENIAL_PREFIX = 'required_local_execution_denied'
export const REQUESTED_LOCAL_EXECUTION_KIND = 'requested_local_execution'
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

function operationDigest(argv: readonly string[]): string {
  return sha256Canonical({ argv, cwd: '.' })
}

function executionRef(version: 1 | 2, scope: ExecutionScope, digest: string): string {
  return `${REF_PREFIX}:v${version}:${scope}:${digest}`
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
        const [start, ...rest] = piece.split(/[.!](?=\s|$)|(?<=\?)\s+|;/)
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

function coveredByExactVerifier(argv: readonly string[], criteria: readonly AcceptanceRequirementV1[]): boolean {
  return criteria.some(({ required, verification }) => required &&
    verification.executable_id !== undefined && verification.executable_id === argv[0] && verification.argv !== undefined &&
    (verification.working_directory ?? '.') === '.' &&
    operationDigest([verification.executable_id, ...verification.argv]) === operationDigest(argv))
}

/** Admit task-authored foreground effects into completion, independently of verifier authority. */
export function requestedLocalExecutionAcceptance(input: {
  request: string
  activeProse: readonly string[]
  existingCriteria: readonly AcceptanceRequirementV1[]
}): { criteria: AcceptanceRequirementV1[]; provenance: TaskContractProvenanceRecord[] } {
  const clauses = activeClauses(input.activeProse)
  const criteria: AcceptanceRequirementV1[] = []
  const refs = new Set<string>()
  if (clauses.some(clause => EXAMPLE_FRAME.test(clause) || RESTRICTED_RUN.test(clause.replace(/`[^`]*`/g, ''))))
    return { criteria, provenance: [] }

  const declaredScripts = [...new Set(clauses.flatMap(clause => DECLARED_SCRIPT.exec(clause)?.[1] ?? []))]
  // Only a sole operation proves that no independent work remains.
  const scope = clauses.length === 1 && input.request.trim().replace(/[.!]$/, '') === clauses[0]
    ? 'standalone' : 'mixed'
  const sourceDigest = sha256Canonical(input.request)
  let descriptions: Set<string> | undefined
  for (const clause of new Set(clauses)) {
    // A derived operation must be traceable to literal user text. Its source
    // reference binds the original request and exact active clause.
    if (!input.request.includes(clause)) continue
    const command = EXACT_RUN.exec(clause)?.[1]
    const exactArgv = command ? argvForLocalOperation(command) : null
    const argvAlternatives = exactArgv ? [exactArgv] : jobArgv(clause, declaredScripts)
    if (argvAlternatives.length === 0) continue
    const operations = argvAlternatives.map(operationDigest)
    for (const digest of operations) refs.add(executionRef(2, scope, digest))
    if (exactArgv && coveredByExactVerifier(exactArgv, input.existingCriteria)) continue

    const clauseDigest = sha256Canonical(clause)
    const identity = sha256Canonical({ sourceDigest, clauseDigest, operations })
    const id = `acceptance:requested-local-execution:${identity.slice(0, 32)}`
    const baseDescription = `Requested foreground effect: ${redactSecrets(clause)}`
    descriptions ??= new Set(input.existingCriteria.map(item => redactSecrets(item.description)))
    let description = baseDescription
    for (let suffix = 2; descriptions.has(description); suffix++)
      description = `${baseDescription} (${suffix})`
    descriptions.add(description)
    criteria.push({
      id, description, required: true, type: 'runtime',
      verification_strategy: 'Require a governed runtime observation that the requested operation produced its effect.',
      verification: {
        kind: REQUESTED_LOCAL_EXECUTION_KIND,
        verifier_id: `requested-local-execution:${identity}`,
        working_directory: '.',
      },
    })
    refs.add(`${REF_PREFIX}:criterion:v1:${sourceDigest}:${clauseDigest}:${id}`)
  }
  return { criteria, provenance: [...refs].map(ref => ({ kind: 'derived_acceptance', ref })) }
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
  const digest = operationDigest(argv)
  const hasRef = (version: 1 | 2, scope: ExecutionScope) =>
    records.some(record => record.kind === 'derived_acceptance' && record.ref === executionRef(version, scope, digest))
  if (hasRef(2, 'mixed')) return 'mixed'
  if (hasRef(2, 'standalone')) return 'standalone'
  // Archived V1 contracts never acquire a criterion on restore, and their
  // broader frame recognition cannot justify an early stop.
  return hasRef(1, 'mixed') || hasRef(1, 'standalone') ? 'mixed' : null
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
  processCompleted?: boolean | undefined
  exit_code?: number | undefined
  simulated?: boolean | undefined
  error?: string | undefined
}

/** Report a remaining hard denial after its batch, or at completion after independent work. */
export function requiredLocalExecutionBlock(
  log: readonly ExecutionLogRow[],
  options: { final: boolean },
): { answer: string; blockedReport: BlockedReport } | null {
  const completed = new Map<string, boolean>()
  let blocked: ExecutionLogRow | undefined
  let authority = ''
  for (const row of [...log].reverse()) {
    if ((row.tool !== 'run_command' && row.tool !== 'test_run') || !row.working_directory ||
        row.detail?.startsWith('background started ')) continue
    const argv = argvForLocalOperation(row.target)
    if (!argv) continue
    const key = sha256Canonical({ argv, cwd: row.working_directory })
    if (row.processExecuted === true && row.preDispatchNoEffect !== true && row.simulated !== true &&
        !completed.has(key))
      completed.set(key, row.processCompleted === true && row.exit_code === 0 && !row.error)
    if (row.preDispatchNoEffect !== true || row.processExecuted === true || completed.get(key) === true) continue
    const marker = /^required_local_execution_denied:(standalone|mixed):(no_lease|missing_capability|unresolved)$/.exec(row.detail ?? '')
    if (!marker || (!options.final && marker[1] !== 'standalone')) continue
    blocked = row
    authority = marker[2]!
    break
  }
  if (!blocked) return null

  const target = redactSecrets(blocked.target).replace(/[\r\n\t]+/g, ' ').slice(0, 240)
  const cause = authorityExplanation(authority)
  const reason = `DENY_MISSING_AUTHORITY: ${cause}`
  const missing = `Successful settlement of required foreground command: ${target}`
  return {
    answer: `Babel denied the required command before dispatch: \`${target}\`. ${cause} No process started for this attempt, and this denial was ineligible for approval. The requested effect remains unconfirmed.`,
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
