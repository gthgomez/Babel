import { relative, resolve } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import type { BlockedReport } from '../schemas/agentContracts.js'
import { foregroundTaskClauses, formatArgvAsCommand, parseForegroundCommandClause, parseSingleProcessArgv } from '../utils/commandArgv.js'
import { foregroundDenialTargets, invokesProhibitedScript, LOCAL_SCRIPT_PATH as SCRIPT_PATH } from '../utils/commandDenialProse.js'
import { physicalWorkspacePath, resolveSandboxProjectPath, workspaceMountPath } from '../utils/projectPath.js'
import { redactSecrets } from '../utils/redaction.js'
import type { ChatToolAction } from './chatToolDefinitions.js'
import { explicitNodeTestFileArgs } from './completionGatePolicy.js'
import { parseUnifiedDiff } from './codingLoop/patchApply.js'
import { inferFreshTaskAcceptance, type AcceptanceMeaningSource } from './taskAcceptanceMeaning.js'
import { taskProhibitsCommand, taskProhibitsForegroundCommand, v3TaskProhibitsCommand } from './taskCommandProhibitions.js'
import type { AcceptanceRequirementV1, TaskContractProvenanceRecord, TaskContractV1 } from './taskContract.js'

const REF_PREFIX = 'babel:requested-local-execution'
const DENIAL_PREFIX = 'required_local_execution_denied'
const DESCRIPTION_PREFIX = 'Requested foreground effect: '
export const REQUESTED_LOCAL_EXECUTION_KIND = 'requested_local_execution'
const FILE_PATH = String.raw`(?:\./)?[\p{L}\p{N}_-][\p{L}\p{N}_.\/-]*`
const DECLARED_SCRIPT = new RegExp(String.raw`^(?:please\s+)?(?:add|create|write)\s+\x60?(${SCRIPT_PATH})\x60?(?=$|[\s,])`, 'iu')
const LOCAL_JOB = new RegExp(String.raw`^(?:please\s+)?(?:run|execute)\s+(?:the exporter|\x60?(${SCRIPT_PATH})\x60?)\s+to\s+(?:create|generate)\s+\x60?(${FILE_PATH})\x60?\s+from\s+\x60?(${FILE_PATH})\x60?(?:\s+and\s+leave\s+both\b[^.;]*)?$`, 'iu')
const INPUT_FIRST_JOB = new RegExp(String.raw`^(?:please\s+)?(?:run|execute)\s+(?:the exporter|\x60?(${SCRIPT_PATH})\x60?)\s+(?:using|with)\s+\x60?(${FILE_PATH})\x60?\s+and\s+(?:save|write)\s+the\s+(?:result|output|resulting\s+(?:CSV|JSON|text))\s+(?:as|to)\s+\x60?(${FILE_PATH})\x60?$`, 'iu')
const DECLARED_CLI_PARAMETERS = /^,\s+an?\s+[\w -]*\bCLI (?:taking an input [\w -]+ file and an output [\w -]+ path|with input and output (?:arguments|parameters))$/i

type LocalRun = Extract<ChatToolAction, { type: 'run_command' | 'test_run' }>
type ExecutionScope = 'standalone' | 'mixed'
export type MissingLocalExecutionAuthority = 'no_lease' | 'missing_capability' | 'unresolved'

function operationDigest(argv: readonly string[]): string {
  return sha256Canonical({ argv, cwd: '.' })
}

function executionRef(version: 1 | 2, scope: ExecutionScope, digest: string): string {
  return `${REF_PREFIX}:v${version}:${scope}:${digest}`
}

function jobArgv(clause: string, declaredScripts: readonly string[], acceptInputFirst = true): string[][] {
  if (/\b(?:if|unless|when|optional)\b/i.test(clause)) return []
  const job = LOCAL_JOB.exec(clause)
  const inputFirst = !job && acceptInputFirst ? INPUT_FIRST_JOB.exec(clause) : null
  if (!job && !inputFirst) return []
  const script = (job?.[1] ?? inputFirst?.[1]) ?? (declaredScripts.length === 1 ? declaredScripts[0] : undefined)
  const source = job?.[3] ?? inputFirst?.[2]
  const destination = job?.[2] ?? inputFirst?.[3]
  if (!script || !source || !destination || [script, source, destination].some(path => path.split('/').includes('..'))) return []
  const executables = /\.py$/i.test(script) ? ['python3', 'python'] : ['node']
  return executables.map(executable => [executable, script, source, destination])
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
  projectRoot?: string
  existingCriteria: readonly AcceptanceRequirementV1[]
  amendment?: boolean
  replayV3?: boolean
}): {
  criteria: AcceptanceRequirementV1[]
  provenance: TaskContractProvenanceRecord[]
  sources: AcceptanceMeaningSource[]
} {
  const clauses = foregroundTaskClauses(input.activeProse, input.amendment === true)
  const criteria: AcceptanceRequirementV1[] = []
  const sources: AcceptanceMeaningSource[] = []
  const refs = new Set<string>()

  const declaredScripts = [...new Set(clauses.flatMap(clause => DECLARED_SCRIPT.exec(clause)?.[1] ?? []))]
  // Only a sole operation proves that no independent work remains.
  const scope = !input.amendment && clauses.length === 1 && input.request.trim().replace(/[.!]$/, '') === clauses[0]
    ? 'standalone' : 'mixed'
  const sourceDigest = sha256Canonical(input.request)
  // Existing amendment descriptors retain their original hashed operations.
  const prohibits = input.replayV3 ? v3TaskProhibitsCommand : taskProhibitsCommand
  let descriptions: Set<string> | undefined
  for (const clause of new Set(clauses)) {
    // A derived operation must be traceable to literal user text. Its source
    // reference binds the original request and exact active clause.
    const start = input.request.indexOf(clause)
    if (start === -1) continue
    const uniqueSource = input.request.indexOf(clause, start + clause.length) === -1
    // Amendment descriptors require exact offsets. Fresh admission can still
    // bind a repeated active clause by digest without inventing a span.
    if (input.amendment && !uniqueSource) continue
    const exactArgv = parseForegroundCommandClause(clause)
    // Frozen amendment descriptors replay their original operation grammar.
    const argvAlternatives = (exactArgv ? [exactArgv] : jobArgv(clause, declaredScripts, !input.amendment))
      .filter(argv => !prohibits(input.activeProse, formatArgvAsCommand(argv)))
    if (argvAlternatives.length === 0) continue
    if (!input.amendment && !exactArgv && argvAlternatives[0]?.[3] &&
        taskProhibitsRequestedOutput(input.activeProse, argvAlternatives[0][3], input.projectRoot ?? process.cwd())) continue
    if (!input.amendment && argvAlternatives.every(argv =>
      taskProhibitsForegroundCommand(input.activeProse, formatArgvAsCommand(argv), input.projectRoot))) continue
    const operations = argvAlternatives.map(operationDigest)
    const baseDescription = `${DESCRIPTION_PREFIX}${redactSecrets(clause)}`
    if (input.amendment && input.existingCriteria.some(item =>
      item.required && item.verification.kind === REQUESTED_LOCAL_EXECUTION_KIND && item.description === baseDescription)) continue
    for (const digest of operations) refs.add(executionRef(2, scope, digest))
    if (exactArgv && coveredByExactVerifier(exactArgv, input.existingCriteria)) continue

    const clauseDigest = sha256Canonical(clause)
    const identity = sha256Canonical({ sourceDigest, clauseDigest, operations })
    const id = `acceptance:requested-local-execution:${identity.slice(0, 32)}`
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
    if (uniqueSource)
      sources.push({ criterion_id: id, status: 'explicit', input_digest: sourceDigest, start, end: start + clause.length })
  }
  return { criteria, provenance: [...refs].map(ref => ({ kind: 'derived_acceptance', ref })), sources }
}

/** Recognize only the request-operation provenance families written by amendment admission. */
export function isRequestedOperationAmendmentRef(ref: string): boolean {
  return /^babel:requested-local-execution:(?:v2:mixed:[0-9a-f]{64}|criterion:v1:[0-9a-f]{64}:[0-9a-f]{64}:acceptance:requested-local-execution:[0-9a-f]{32})$/.test(ref)
}

/** Required foreground execution can already be covered by an exact verifier criterion. */
export function hasRequestedLocalExecution(
  records: readonly TaskContractProvenanceRecord[], scope?: ExecutionScope,
): boolean {
  return records.some(record => record.kind === 'derived_acceptance' &&
    /^babel:requested-local-execution:v2:(?:mixed|standalone):[0-9a-f]{64}$/.test(record.ref) &&
    (!scope || record.ref.startsWith(`${REF_PREFIX}:v2:${scope}:`)))
}

export interface RequestedForegroundEffect {
  criterionId: string
  argv: string[]
  inputPaths: string[]
  outputPath?: string
}

/** This native runtime query does not evaluate project code or write workspace files. */
export function isReadOnlyForegroundQuery(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === 'node' && argv[1] === '--version'
}

/** Resolve literal commands from the frozen criterion and its task-authored provenance. */
export function frozenExactForegroundCommands(
  contract: TaskContractV1, amendments: readonly string[] = [],
): Map<string, RequestedForegroundEffect> {
  const commands = new Map<string, RequestedForegroundEffect>()
  if (!contract.frozen) return commands
  const ambiguous = new Set<string>()
  const records = new Set(contract.provenance.records.filter(record => record.kind === 'derived_acceptance')
    .map(record => record.ref))
  const activeProse = inferFreshTaskAcceptance(contract.user_request).activeProse
  const inputs = new Map([contract.user_request, ...amendments].map((request, index) => {
    const clauses = foregroundTaskClauses(inferFreshTaskAcceptance(request).activeProse, index > 0)
    const scripts = [...new Set(clauses.flatMap(clause => DECLARED_SCRIPT.exec(clause)?.[1] ?? []))]
    return [sha256Canonical(request), { clauses, scripts, amendment: index > 0 }] as const
  }))
  for (const criterion of contract.acceptance) {
    if (!criterion.required || criterion.verification.kind !== REQUESTED_LOCAL_EXECUTION_KIND ||
        criterion.verification.working_directory !== '.' || !criterion.description.startsWith(DESCRIPTION_PREFIX)) continue
    const clause = criterion.description.slice(DESCRIPTION_PREFIX.length)
    const clauseDigest = sha256Canonical(clause)
    const claim = [...records].filter(ref => ref.startsWith(`${REF_PREFIX}:criterion:v1:`) &&
      ref.endsWith(`:${clauseDigest}:${criterion.id}`))
    if (claim.length !== 1) continue
    const sourceDigest = claim[0]!.split(':')[4]
    if (!sourceDigest || !/^[a-f0-9]{64}$/.test(sourceDigest)) continue
    const exact = parseForegroundCommandClause(clause)
    const source = inputs.get(sourceDigest)
    if (!source?.clauses.includes(clause)) continue
    const sourceProse = [...activeProse, ...source.clauses]
    const candidates = (exact ? [exact] : jobArgv(clause, source.scripts, !source.amendment)).filter(argv => {
      const command = formatArgvAsCommand(argv)
      return redactSecrets(command) === command && !taskProhibitsCommand(sourceProse, command)
    })
    const operations = candidates.map(operationDigest)
    const identity = sha256Canonical({ sourceDigest, clauseDigest, operations })
    if (criterion.id !== `acceptance:requested-local-execution:${identity.slice(0, 32)}` ||
        criterion.verification.verifier_id !== `requested-local-execution:${identity}`) continue
    for (const argv of candidates) {
      const digest = operationDigest(argv)
      if (!records.has(executionRef(2, 'mixed', digest)) && !records.has(executionRef(2, 'standalone', digest))) continue
      const command = formatArgvAsCommand(argv)
      const script = argv[1]
      const inputPaths = script && new RegExp(`^${SCRIPT_PATH}$`, 'u').test(script) ? [script] : []
      const outputPath = exact ? undefined : argv[3]
      if (outputPath) inputPaths.push(argv[2]!)
      if (commands.has(command)) ambiguous.add(command)
      commands.set(command, { criterionId: criterion.id, argv, inputPaths, ...(outputPath ? { outputPath } : {}) })
    }
  }
  for (const command of ambiguous) commands.delete(command)
  return commands
}

/** Resolve a frozen exact process or the initial objective's declared file effect for receipt capture. */
export function requestedForegroundEffect(
  contract: TaskContractV1, action: LocalRun, projectRoot: string, amendments: readonly string[] = [],
): RequestedForegroundEffect | undefined {
  if (!contract.frozen || redactSecrets(action.command) !== action.command ||
      !requiredLocalExecutionScope(contract.provenance.records, action, projectRoot)) return
  const argv = parseSingleProcessArgv(action.command)
  if (!argv) return
  return frozenExactForegroundCommands(contract, amendments).get(formatArgvAsCommand(argv))
}

/** Match a foreground proposal to an admission-time operation identity, for settlement only. */
export function requiredLocalExecutionScope(
  records: readonly TaskContractProvenanceRecord[],
  action: LocalRun,
  projectRoot: string,
): ExecutionScope | null {
  if (action.type === 'run_command' && (action.background || action.detached)) return null
  return requestedProcessScope(records, action, projectRoot)
}

/** Match a task-required process independently of a proposed foreground/background lane. */
export function requestedProcessScope(
  records: readonly TaskContractProvenanceRecord[],
  action: LocalRun,
  projectRoot: string,
): ExecutionScope | null {
  if (resolveSandboxProjectPath(projectRoot, action.cwd ?? '.', true) !== resolve(projectRoot)) return null
  const argv = parseSingleProcessArgv(action.command)
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

/** A direct edit cannot substitute for an explicitly requested process output. */
export function substitutesRequestedProcessOutput(
  records: readonly TaskContractProvenanceRecord[],
  sourceRequests: readonly string[],
  action: Extract<ChatToolAction, { type: 'write_file' | 'str_replace' | 'apply_patch' }>,
  projectRoot: string,
  currentProse: readonly string[] = [],
): boolean {
  const admitted = new Set(records.filter(record => record.kind === 'derived_acceptance' &&
    record.ref.startsWith(`${REF_PREFIX}:v2:`)).map(record => record.ref))
  // Resolve "the exporter" within each request as admission did. Later
  // amendments must not make a script declaration in the objective ambiguous.
  const directDenials = foregroundDenialTargets(currentProse).outputs
  const requiredOutputs = new Set([...directDenials, ...sourceRequests.flatMap((request, index) => {
    const { activeProse } = inferFreshTaskAcceptance(request)
    const { outputs } = foregroundDenialTargets(activeProse)
    const clauses = foregroundTaskClauses(activeProse, index > 0)
    const scripts = [...new Set(clauses.flatMap(clause => DECLARED_SCRIPT.exec(clause)?.[1] ?? []))]
    const processOutputs = clauses.flatMap(clause => jobArgv(clause, scripts, index === 0))
      .filter(argv => {
        const digest = operationDigest(argv)
        return admitted.has(executionRef(2, 'mixed', digest)) || admitted.has(executionRef(2, 'standalone', digest)) ||
          taskProhibitsForegroundCommand(activeProse, formatArgvAsCommand(argv), projectRoot)
      })
      .map(argv => argv[3]!)
    return [...outputs, ...processOutputs]
  })])
  if (requiredOutputs.size === 0) return false
  let targets: string[]
  if (action.type === 'apply_patch') {
    const parsed = parseUnifiedDiff(action.patch)
    if (!parsed.ok) return false // Rejected by the patch executor before any edit.
    targets = parsed.files.map(file => file.newPath || file.oldPath)
  } else {
    targets = [action.type === 'write_file' ? action.path : action.file_path]
  }
  const resolvedTargets = targets.map(target => resolveSandboxProjectPath(projectRoot, target, true))
  return [...requiredOutputs].some(output => resolvedTargets.some(target => sameRequestedOutput(output, target, projectRoot)))
}

function sameRequestedOutput(left: string, right: string, projectRoot: string, cwd = '.'): boolean {
  const workingDirectory = physicalWorkspacePath(projectRoot, resolveSandboxProjectPath(projectRoot, cwd, true))
  const mounted = workspaceMountPath(right, true)
  const resolvedLeft = physicalWorkspacePath(projectRoot, workspaceMountPath(left, true) ?? left)
  const resolvedRight = mounted === undefined ? physicalWorkspacePath(workingDirectory, right) : physicalWorkspacePath(projectRoot, mounted)
  return relative(resolvedLeft, resolvedRight) === ''
}

export function taskProhibitsRequestedOutput(activeProse: readonly string[], output: string, projectRoot: string): boolean {
  return foregroundDenialTargets(activeProse).outputs.some(target => sameRequestedOutput(target, output, projectRoot))
}

/** Recognize a declared job's prohibited destination independently of receipt eligibility. */
export function taskProhibitsDeclaredJob(
  activeProse: readonly string[], command: string, projectRoot: string, cwd = '.',
): boolean {
  const { outputs } = foregroundDenialTargets(activeProse)
  if (outputs.length === 0) return false
  const argv = parseSingleProcessArgv(command)
  if (!argv || argv.length < 3) return false
  if (!argv.slice(1).some(operand => outputs.some(path => sameRequestedOutput(path, operand, projectRoot, cwd)))) return false
  const clauses = foregroundTaskClauses(activeProse)
  const scripts = [...new Set(clauses.flatMap(clause => DECLARED_SCRIPT.exec(clause)?.[1] ?? []))]
  return clauses.flatMap(clause => jobArgv(clause, scripts)).some(job =>
    invokesProhibitedScript(argv, [job[1]!], projectRoot, cwd, explicitNodeTestFileArgs, ([, destination]) =>
      destination !== undefined && outputs.some(path => sameRequestedOutput(path, destination, projectRoot, cwd))))
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

/** Finish a blocked transformation only when the request's independent setup already settled. */
export function hasSettledLocalJobSetup(input: {
  contract: TaskContractV1
  effect: RequestedForegroundEffect
  root: string
  log: readonly (ExecutionLogRow & { effect_status?: string; mutation_paths?: readonly string[] })[]
}): boolean {
  const { contract, effect, root, log } = input
  const [, script, source, destination] = effect.argv
  if (!effect.outputPath || !script || !source || destination !== effect.outputPath ||
      contract.verifier_requirements.length > 0) return false
  const clauses = foregroundTaskClauses(inferFreshTaskAcceptance(contract.user_request).activeProse)
  const declaration = clauses[0]
  const declared = declaration && DECLARED_SCRIPT.exec(declaration)
  // Other prose remains eligible for independent work. These forms describe
  // the declared script, its output format, or an input to leave unchanged.
  if (!declaration || !declared || declared[1] !== script ||
      !DECLARED_CLI_PARAMETERS.test(declaration.slice(declared[0].length))) return false
  if (clauses.filter(clause => jobArgv(clause, [script]).some(args =>
    operationDigest(args) === operationDigest(effect.argv))).length !== 1) return false
  if (clauses.slice(1).some(clause => {
    if (LOCAL_JOB.test(clause) || INPUT_FIRST_JOB.test(clause)) {
      const suffix = /\s+and\s+leave\s+both\b.*$/i.exec(clause)?.[0]
      return (suffix !== undefined && !/^\s+and leave both the (?:script|exporter|program|CLI) and (?:the )?generated [\w -]+ in the (?:repository|project|workspace)$/i.test(suffix)) ||
        !jobArgv(clause, [script]).some(args => operationDigest(args) === operationDigest(effect.argv))
    }
    if (/^It (?:should|must) (?:read|export|convert|transform|write)\b[^;!?]+$/i.test(clause) &&
        !/\b(?:and|also|then|or)\s+(?:add|create|edit|update|write|run|check|review|verify|test|fix|repair|remove)\b/i.test(clause)) return false
    if (/^Use (?:UTF-\d+|ASCII) and (?:LF|CRLF) line endings$/i.test(clause)) return false
    if (/^Keep [\p{L}\p{N} ,_-]+ intact(?: using [\p{L}\p{N} -]+)?$/iu.test(clause)) return false
    if (/^Keep the (?:script|exporter|program|CLI) and its output in the (?:repository|project|workspace)$/i.test(clause)) return false
    if (/^Show the verification you performed$/i.test(clause)) return false
    const preserved = /^Leave\s+`?([^`\s]+)`?\s+unchanged$/i.exec(clause)?.[1]
    return preserved !== source
  })) return false
  const required = contract.acceptance.filter(item => item.required && item.id !== effect.criterionId)
  if (required.some(item => item.description !== contract.user_request ||
      !item.verification.verifier_id.startsWith('meaning:'))) return false
  const writes = log.filter(row => row.effect_status === 'confirmed_change' && !row.error)
  return writes.length > 0 && writes.every(row => row.tool === 'write_file' &&
    (row.mutation_paths?.length ?? 0) === 1 &&
    relative(resolve(root, script), resolve(root, row.mutation_paths![0]!)) === '')
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
    const argv = parseSingleProcessArgv(row.target)
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
    answer: `Required command denied before dispatch: \`${target}\`. ${cause} No process started for this attempt, and this denial was ineligible for approval. The requested effect remains unconfirmed.`,
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
