import { existsSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { canonicalJson, sha256Canonical } from '../acceptance/canonical.js'
import { formatArgvAsCommand, parseCommandArgv } from '../utils/commandArgv.js'
import {
  explicitNodeTestFileArgs,
  isAuthoritativeVerifierCommand,
  parseStructuredVerifierCommand,
} from './completionGatePolicy.js'
import type { AcceptanceRequirementV1, AcceptanceRequirementType, VerificationSpecV1 } from './taskContract.js'
import type { AcceptanceMeaningSource, TaskAcceptanceMeaning } from './taskAcceptanceMeaning.js'
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'
import { assertionEvidenceMatches, stripJsComments } from './verifierBehaviorEvidence.js'
import { markAdvisoryDocsGoals } from './advisoryDocsGoal.js'
import {
  isPublicApiPreservationStatement,
  PUBLIC_API_PRESERVATION_STRATEGY,
} from './publicApiPreservation.js'
import {
  readVerifierCommandInput,
  verifierCommandInputFiles,
  type VerifierCommandInputOverrides,
} from './verifierCommandInputs.js'

function isUnresolvedCriterion(criterion: AcceptanceRequirementV1): boolean {
  return (
    criterion.verification.verifier_id.startsWith('meaning:') &&
    criterion.verification_strategy.includes('unresolved')
  )
}

export const ACCEPTANCE_EXECUTABLE_BINDING_REF = 'babel:acceptance-exec-bind:v1'
const CRITERION_VERIFIER_LINK_REF = 'babel:criterion-verifier-link:v1'

/** Positive success tail matched as the entire remainder (no leading obligations). */
const POSITIVE_SUCCESS_SUFFIX =
  /(?:must\s+|shall\s+)?(?:pass|passes|succeed|succeeds|exit(?:s)?(?:\s+with)?(?:\s+code)?\s*0)\.?$/i

const FULLY_ANCHORED_POSITIVE_SUCCESS_TAIL = new RegExp(
  `^${POSITIVE_SUCCESS_SUFFIX.source}$`,
  'i',
)

function isFullyAnchoredPositiveSuccessTail(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && FULLY_ANCHORED_POSITIVE_SUCCESS_TAIL.test(trimmed)
}

const COMPOUND_OR_NEGATED_RE =
  /\b(?:and|or|but|unless|except|when|if|not|fail|fails|failing|failed|error|errors|invalid|broken|red)\b/i

function structuredCommandIdentity(command: string): string | null {
  const parsed = parseStructuredVerifierCommand(command.trim(), {
    authoritySource: 'built_in_runner',
  })
  if (!parsed) return null
  return sha256Canonical({
    executable: parsed.executable.toLowerCase(),
    argv: parsed.args,
  })
}

/**
 * Reconstruct the full frozen verifier command (executable + full argv) for
 * identity comparison. Returns null when the representation is ambiguous or
 * cannot round-trip through the structured command parser (fail-closed).
 */
export function canonicalCommandFromFrozenVerification(
  verification: Pick<VerificationSpecV1, 'executable_id' | 'argv'>,
): string | null {
  const executable = verification.executable_id?.trim()
  const argv = verification.argv
  if (!executable || !argv || argv.length === 0) return null
  let display: string
  try {
    display = formatArgvAsCommand([executable, ...argv])
  } catch {
    return null
  }
  const parsed = parseStructuredVerifierCommand(display, {
    authoritySource: 'built_in_runner',
  })
  if (!parsed || parsed.executable.toLowerCase() !== executable.toLowerCase()) {
    return null
  }
  try {
    if (canonicalJson(parsed.args) !== canonicalJson(argv)) return null
    const reparsedArgv = parseCommandArgv(display)
    if (canonicalJson(reparsedArgv.slice(1)) !== canonicalJson(argv)) return null
  } catch {
    return null
  }
  const identity = structuredCommandIdentity(display)
  const expected = sha256Canonical({ executable: executable.toLowerCase(), argv })
  if (!identity || identity !== expected) return null
  return display
}

/** Whether a trusted host command exactly matches a frozen executable binding. */
export function frozenVerificationMatchesTrustedCommand(
  verification: Pick<VerificationSpecV1, 'executable_id' | 'argv'>,
  trustedCommand: string,
): boolean {
  const declared = canonicalCommandFromFrozenVerification(verification)
  if (!declared) return false
  return commandsMatchForExecutableBinding(declared, trustedCommand)
}

/** Trusted and criterion commands must match exact parsed argv (no alias or prefix weakening). */
export function commandsMatchForExecutableBinding(
  criterionCommand: string,
  trustedCommand: string,
): boolean {
  const left = structuredCommandIdentity(criterionCommand)
  const right = structuredCommandIdentity(trustedCommand)
  if (!left || !right || left !== right) return false
  try {
    return canonicalJson(parseCommandArgv(criterionCommand.trim())) === canonicalJson(parseCommandArgv(trustedCommand.trim()))
  } catch {
    return false
  }
}

/**
 * Extract a single command with supported positive-success semantics only.
 * Returns null for negated, compound, conditional, or non-success assertions.
 */
function splitCommandAndSuccessTail(text: string): { command: string; tail: string } | null {
  const match = text.trim().match(new RegExp(`^([\\s\\S]+?)\\s+(${POSITIVE_SUCCESS_SUFFIX.source})$`, 'i'))
  if (!match) return null
  const command = match[1]!.trim()
  const tail = match[2]!.trim()
  if (!command || !isFullyAnchoredPositiveSuccessTail(tail)) return null
  return { command, tail }
}

export function extractPositiveCommandSuccessCriterion(description: string): string | null {
  const trimmed = description.trim()
  if (!trimmed || COMPOUND_OR_NEGATED_RE.test(trimmed)) return null

  const backtick = trimmed.match(/^`([^`]+)`\s+([\s\S]+)$/)
  if (backtick) {
    const inner = backtick[1]!.trim()
    const rest = backtick[2]!.trim()
    if (!isFullyAnchoredPositiveSuccessTail(rest)) return null
    if (!isAuthoritativeVerifierCommand(inner)) return null
    return inner
  }

  const plain = splitCommandAndSuccessTail(trimmed)
  if (!plain) return null
  if (plain.command.includes('`')) return null
  if (!isAuthoritativeVerifierCommand(plain.command)) return null
  return plain.command
}

/**
 * True only when the criterion is a supported positive command-success assertion
 * naming the exact trusted argv (no substring, alias, or extra obligations).
 */
export function criterionExplicitlyNamesTrustedCommand(
  description: string,
  command: string,
): boolean {
  const criterionCommand = extractPositiveCommandSuccessCriterion(description)
  if (!criterionCommand) return false
  return commandsMatchForExecutableBinding(criterionCommand, command)
}

function requirementTypeForCommand(command: string): AcceptanceRequirementType {
  const identity = analyzeVerifierIdentity(command)
  const lower = command.toLowerCase()
  if (/typecheck|tsc\b/.test(lower)) return 'typecheck'
  if (/\blint\b/.test(lower)) return 'lint'
  if (/\bbuild\b/.test(lower)) return 'build'
  if (identity?.family.includes('test') || /\btest\b/.test(lower)) return 'unit_test'
  return 'custom'
}

function materializeExecutableVerification(
  command: string,
  defaultWorkingDirectory?: string,
  existingVerifierInputFiles?: readonly string[],
): AcceptanceRequirementV1['verification'] | null {
  if (!isAuthoritativeVerifierCommand(command)) return null
  const nodeTestFiles = explicitNodeTestFileArgs(command)
  if (nodeTestFiles !== null && nodeTestFiles.length === 0) return null
  if (nodeTestFiles && existingVerifierInputFiles !== undefined) {
    const frozen = new Set(existingVerifierInputFiles.map(path => path.replace(/\\/g, '/').replace(/^\.\//, '')))
    if (nodeTestFiles.some(path => !frozen.has(path.replace(/\\/g, '/').replace(/^\.\//, '')))) return null
  }
  const parsed = parseStructuredVerifierCommand(command, {
    authoritySource: 'built_in_runner',
  })
  if (!parsed || parsed.authoritySource !== 'built_in_runner') return null
  const argv = parsed.args
  return {
    kind: requirementTypeForCommand(command),
    verifier_id: parsed.verifierId,
    executable_id: parsed.executable,
    argv: [...argv],
    command_hash: sha256Canonical({ executable_id: parsed.executable, argv }),
    ...(defaultWorkingDirectory !== undefined
      ? { working_directory: defaultWorkingDirectory }
      : {}),
    environment_policy: 'host-process',
  }
}

function bindCriterion(
  criterion: AcceptanceRequirementV1,
  command: string,
  defaultWorkingDirectory?: string,
  existingVerifierInputFiles?: readonly string[],
): AcceptanceRequirementV1 {
  const verification = materializeExecutableVerification(command, defaultWorkingDirectory, existingVerifierInputFiles)
  if (!verification) return criterion
  return {
    ...criterion,
    type: requirementTypeForCommand(command),
    verification_strategy: `Run ${command.trim()} as the frozen executable check for this requirement.`,
    verification,
  }
}

function pickTrustedCommand(
  criterion: AcceptanceRequirementV1,
  commands: readonly string[],
  explicitOnly: AcceptanceMeaningSource[],
): string | null {
  if (!criterion.verification.verifier_id.startsWith('meaning:')) return null
  if (isUnresolvedCriterion(criterion)) return null
  const source = explicitOnly.find((item) => item.criterion_id === criterion.id)
  if (!source || source.status !== 'explicit') return null

  const matches = commands.filter((command) =>
    criterionExplicitlyNamesTrustedCommand(criterion.description, command),
  )
  if (matches.length !== 1) return null
  return matches[0]!
}

interface ExplicitCriterionVerifierLink {
  behavior: string
  command: string
}

/**
 * Parse a task-authored verifier link from one criterion only. The command is
 * intentionally required to follow the exact `verified by:` marker and to be
 * the entire remaining positive-success clause. A neighboring green command
 * or a phrase that merely mentions a test never creates this link.
 */
function explicitCriterionVerifierLink(
  criterion: AcceptanceRequirementV1,
): ExplicitCriterionVerifierLink | null {
  const markers = [...criterion.description.matchAll(/[.;]\s+verified by:\s*/gi)]
  if (markers.length !== 1) return null
  const marker = markers[0]!
  const behavior = criterion.description.slice(0, marker.index).trim().replace(/[.;]+$/, '').trim()
  const commandClause = criterion.description.slice(marker.index + marker[0].length).trim()
  const command = extractPositiveCommandSuccessCriterion(commandClause)
  if (!behavior || !command || !isAuthoritativeVerifierCommand(command)) return null
  const nodeTestFiles = explicitNodeTestFileArgs(command)
  if (nodeTestFiles !== null && nodeTestFiles.length === 0) return null
  return { behavior, command }
}

/** Exact commands explicitly designated inside task-authored criteria. */
export function explicitCriterionVerifierCommands(meaning: TaskAcceptanceMeaning): string[] {
  return meaning.criteria.flatMap(criterion => {
    const source = meaning.sources.find(item => item.criterion_id === criterion.id)
    if (source?.status !== 'explicit') return []
    const link = explicitCriterionVerifierLink(criterion)
    const command = link?.command ?? extractPositiveCommandSuccessCriterion(criterion.description)
    if (!command) return []
    const nodeTestFiles = explicitNodeTestFileArgs(command)
    return nodeTestFiles !== null && nodeTestFiles.length === 0 ? [] : [command]
  })
}

function normalizedCriterionText(value: string): string {
  // This identity decides whether a verifier explicitly designated for one
  // behavioral statement may also prove an inferred opening goal. Treat the
  // statement as exact text (apart from framing whitespace and terminal prose
  // punctuation). Normalizing internal whitespace is unsafe: it can change
  // string, regex, HTML <pre>, and other literal content in ways that make two
  // distinct user requirements share verifier authority. Conservative misses
  // simply leave the inferred criterion unbound and therefore unverified.
  return value.trim().replace(/[.!?]+$/, '')
}

function trustedDesignation(
  link: ExplicitCriterionVerifierLink,
  trustedCommands: readonly string[],
): string | null {
  const matches = trustedCommands.filter(command =>
    commandsMatchForExecutableBinding(link.command, command),
  )
  return matches.length === 1 ? matches[0]! : null
}

function bindExplicitCriterionLink(
  criterion: AcceptanceRequirementV1,
  command: string,
  behavior: string,
  defaultWorkingDirectory?: string,
  existingVerifierInputFiles?: readonly string[],
): AcceptanceRequirementV1 {
  const verification = materializeExecutableVerification(command, defaultWorkingDirectory, existingVerifierInputFiles)
  if (!verification) return criterion
  return {
    ...criterion,
    type: requirementTypeForCommand(command),
    verification_strategy: `The task explicitly designates the exact frozen command as evidence for this criterion: ${behavior}`,
    verification,
  }
}

/**
 * A preservation obligation whose regression witness the task's own text designates.
 * The task states the regression tests already exist and names the exact command
 * that must run them. The witness may only re-freeze a command that an explicit
 * criterion of the same meaning already froze verbatim, so it grants no new
 * command authority; every other inferred obligation stays fail-closed (meaning:*).
 */
const PRESERVATION_MARKER_RE = /\bpreserve\b/i
const TESTS_ALREADY_PRESENT_RE = /\btests?\s+are\s+already\s+present\b/i
const DESIGNATED_TEST_COMMAND_RE =
  /\brun\b[^;`]*?\btests?\b[^;`]*?\busing:\s*`?([^`;\n]+?)`?\s*(?=[.;]|$)/i

export function extractDesignatedRegressionWitness(
  activeProse: readonly string[],
): string | null {
  if (!activeProse.some((line) => TESTS_ALREADY_PRESENT_RE.test(line))) return null
  for (const line of activeProse) {
    const match = line.match(DESIGNATED_TEST_COMMAND_RE)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function frozenVerificationIdentity(
  verification: AcceptanceRequirementV1['verification'],
): string | null {
  if (!verification.executable_id || !verification.argv || verification.argv.length === 0) {
    return null
  }
  return sha256Canonical({
    executable: verification.executable_id.toLowerCase(),
    argv: verification.argv,
  })
}

/** The one designated witness command stated in the criterion's own text; null when absent or ambiguous. */
function criterionDesignatedCommand(description: string): string | null {
  const matches = [
    ...description.matchAll(new RegExp(DESIGNATED_TEST_COMMAND_RE.source, 'gi')),
  ]
  if (matches.length !== 1) return null
  const command = matches[0]![1]?.trim()
  return command || null
}

/**
 * The first-pass explicit verification that froze exactly this designated
 * command. Equivalent-argv snapshots with conflicting execution metadata stay
 * fail-closed; they are never collapsed by an overwrite.
 */
function frozenWitnessVerification(
  designated: string,
  explicitBound: readonly AcceptanceRequirementV1[],
): AcceptanceRequirementV1['verification'] | null {
  const identity = structuredCommandIdentity(designated)
  if (!identity) return null
  let snapshot: AcceptanceRequirementV1['verification'] | null = null
  for (const criterion of explicitBound) {
    if (frozenVerificationIdentity(criterion.verification) !== identity) continue
    if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(criterion.verification)) {
      return null
    }
    snapshot = criterion.verification
  }
  return snapshot
}

function bindDesignatedWitnessToCriterion(
  criterion: AcceptanceRequirementV1,
  sources: readonly AcceptanceMeaningSource[],
  explicitBound: readonly AcceptanceRequirementV1[],
): AcceptanceRequirementV1 | null {
  if (!criterion.verification.verifier_id.startsWith('meaning:')) return null
  if (isUnresolvedCriterion(criterion)) return null
  const source = sources.find((item) => item.criterion_id === criterion.id)
  if (!source || source.status !== 'inferred') return null
  // The obligation's own text must carry the preservation claim and the
  // designation; surrounding prose never binds a criterion it does not describe.
  if (!PRESERVATION_MARKER_RE.test(criterion.description)) return null
  if (!TESTS_ALREADY_PRESENT_RE.test(criterion.description)) return null
  const designated = criterionDesignatedCommand(criterion.description)
  if (!designated) return null
  if (!isAuthoritativeVerifierCommand(designated)) return null
  const witness = frozenWitnessVerification(designated, explicitBound)
  if (!witness) return null
  return {
    ...criterion,
    type: requirementTypeForCommand(designated),
    verification_strategy: `The task text designates ${designated} as the regression witness for this preservation requirement; the already-present regression tests must stay unchanged and pass on the candidate revision.`,
    verification: structuredClone(witness),
  }
}

export const ACCEPTANCE_RELEVANCE_BINDING_REF = 'babel:acceptance-relevance-bind:v1'
const RELEVANCE_WITNESS_MARKER = 'relevance-matched executable witness'

const RELEVANT_PATH_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|txt|csv|tsv|json|ya?ml|toml|ini|cfg|conf|md|sh|sql|html|css)$/i
const PATH_CANDIDATE_RE =
  /(?:^|[\s`"'(])((?:\.{1,2}\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*\.[A-Za-z0-9]{1,12})(?=$|[\s`"'),;:])/g
const CALL_EXPRESSION_RE =
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([^()\n]{0,160})\)/
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIALS, '\\$&')
}

interface RelevanceSpec {
  targetPaths: string[]
  callPattern: RegExp | null
  /** Exact expected result phrase (whitespace-sensitive) from the goal. */
  fragment: string | null
}

function normalizeProjectPath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, '/'))
  return normalized.replace(/^\.\//, '').replace(/\/+/g, '/')
}

function pathTokenCandidates(description: string): string[] {
  const candidates = new Set<string>()
  for (const match of description.matchAll(PATH_CANDIDATE_RE)) {
    const token = match[1]!
    if (/^https?:/i.test(token) || token.includes('://')) continue
    if (!RELEVANT_PATH_EXTENSION.test(token)) continue
    candidates.add(normalizeProjectPath(token))
  }
  return [...candidates]
}

function relevanceSpec(description: string): RelevanceSpec | null {
  const targetPaths = pathTokenCandidates(description)
  const call = CALL_EXPRESSION_RE.exec(description)
  let callPattern: RegExp | null = null
  if (call) {
    const symbol = escapeRegex(call[1]!)
    const args = call[2]!.trim()
    if (args) {
      const tokens = args
        .split(/[^A-Za-z0-9_$.-]+/)
        .map(token => token.trim())
        .filter(token => token.length > 0)
        .map(escapeRegex)
      callPattern = tokens.length
        ? new RegExp(`\\b${symbol}\\s*\\(\\s*${tokens.join('\\s*,\\s*')}\\s*\\)`)
        : new RegExp(`\\b${symbol}\\s*\\(`)
    } else {
      callPattern = new RegExp(`\\b${symbol}\\s*\\(`)
    }
  }
  const resultVerb = /\b(?:returns?|equals?|is|becomes?|outputs?|produces?)\b/gi
  const verbMatches = [...description.matchAll(resultVerb)]
  const lastVerb = verbMatches.at(-1)
  const resultTail = lastVerb && description.length - (lastVerb.index! + lastVerb[0].length) <= 200
    ? description.slice(lastVerb.index! + lastVerb[0].length).trim().replace(/[.;]+$/, '').trim()
    : undefined
  const assignmentTail = description.match(/=\s*([^.;\n]{1,120})/)?.[1]?.trim()
  const fragment = resultTail
    ? resultTail.replace(/^[\`\"']/, '').replace(/[\`\"']$/, '')
    : assignmentTail
      ? assignmentTail.replace(/^[\`\"']/, '').replace(/[\`\"']$/, '')
      : null
  if (!targetPaths.length && !callPattern) return null
  return { targetPaths, callPattern, fragment }
}

/** References inside a verifier input that resolve to an existing project file. */
function referencedExistingPaths(
  projectRoot: string,
  inputFile: string,
  content: string,
  fs: VerifierCommandInputOverrides,
): string[] {
  const resolved = new Set<string>()
  // Quoted strings can carry imports or data-file reads without an extension
  // boundary that the generic tokenizer sees.
  const quoted = [...content.matchAll(/["'`]([^"'`\n]{1,200})["'`]/g)].map(match => match[1]!)
  const tokens = [
    ...[...content.matchAll(PATH_CANDIDATE_RE)].map(match => match[1]!),
    ...quoted,
  ]
  for (const token of tokens) {
    if (!RELEVANT_PATH_EXTENSION.test(token) || token.includes('://')) continue
    const lexical = token.replace(/\\/g, '/')
    const bases = lexical.startsWith('.') ? [dirname(inputFile)] : [dirname(inputFile), '']
    for (const base of bases) {
      const relative = normalizeProjectPath(base ? `${base}/${lexical}` : lexical)
      if (relative.startsWith('../') || relative.includes('/../') || /^[A-Za-z]:|^\//.test(relative)) continue
      const absolute = join(projectRoot, relative)
      const exists = fs.exists ?? existsSync
      const isFile = fs.isFile ?? ((value: string) => {
        try { return statSync(value).isFile() } catch { return false }
      })
      if (exists(absolute) && isFile(absolute)) resolved.add(relative)
    }
  }
  return [...resolved]
}

/** Local bindings imported from a module that provides the goal's target file. */
function importedSymbolsForTarget(
  content: string,
  inputFile: string,
  targetPaths: readonly string[],
): string[] {
  const symbols = new Set<string>()
  const matchesTarget = (specifier: string): boolean => {
    if (!specifier.startsWith('.')) return false
    const resolved = normalizeProjectPath(`${dirname(inputFile)}/${specifier}`)
    return targetPaths.some(target => resolved === target || resolved.endsWith(`/${target}`))
  }
  for (const match of content.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (!matchesTarget(match[2]!)) continue
    const clause = match[1]!.trim()
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1]
    if (namespace) symbols.add(namespace)
    const named = clause.match(/\{([^}]*)\}/)?.[1]
    if (named) {
      for (const item of named.split(',')) {
        const binding = item.trim().split(/\s+as\s+/).at(-1)?.trim()
        if (binding && /^[A-Za-z_$][\w$]*$/.test(binding)) symbols.add(binding)
      }
    }
    const defaultBinding = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, '').trim().replace(/,$/, '').trim()
    if (/^[A-Za-z_$][\w$]*$/.test(defaultBinding)) symbols.add(defaultBinding)
  }
  for (const match of content.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!matchesTarget(match[2]!)) continue
    for (const item of match[1]!.split(',')) {
      const binding = item.trim().split(':').at(-1)?.trim()
      if (binding && /^[A-Za-z_$][\w$]*$/.test(binding)) symbols.add(binding)
    }
  }
  return [...symbols]
}

function specMatchesContent(input: {
  projectRoot: string
  inputFile: string
  content: string
  spec: RelevanceSpec
  fs: VerifierCommandInputOverrides
}): boolean {
  // Comments and skipped registrations are never executable evidence.
  const code = stripJsComments(input.content)
  const references = referencedExistingPaths(
    input.projectRoot,
    input.inputFile,
    code,
    input.fs,
  )
  const pathMatched = input.spec.targetPaths.length === 0
    ? true
    : input.spec.targetPaths.some(target =>
        references.some(reference => reference === target || reference.endsWith(`/${target}`)),
      )
  if (!pathMatched) return false
  // The expected result must be an operand of a real assertion. With a call
  // goal the exact call must share that assertion. Without a call, the
  // assertion must also use a binding imported from the goal's target module;
  // an unrelated value that happens to equal the fragment is not evidence.
  if (input.spec.fragment === null) return false
  const codeTargets = input.spec.targetPaths.filter(path => RELEVANT_PATH_EXTENSION.test(path) && /\.(?:[cm]?[jt]sx?)$/i.test(path))
  const dataTargets = input.spec.targetPaths.filter(path => !codeTargets.includes(path))
  const requiredSymbols = input.spec.callPattern
    ? []
    : [
        ...importedSymbolsForTarget(code, input.inputFile, codeTargets),
        ...dataTargets.flatMap(path => [path, posix.basename(path)]),
      ]
  if (!input.spec.callPattern && requiredSymbols.length === 0) return false
  return assertionEvidenceMatches(
    code,
    input.spec.callPattern,
    input.spec.fragment,
    { requiredSymbols },
  )
}

function relevantTrustedCommands(input: {
  criterion: AcceptanceRequirementV1
  trusted: readonly string[]
  projectRoot: string
  fs: VerifierCommandInputOverrides
}): string[] {
  if (isUnresolvedCriterion(input.criterion)) return []
  if (!input.criterion.verification.verifier_id.startsWith('meaning:')) return []
  const spec = relevanceSpec(input.criterion.description)
  if (!spec) return []
  return input.trusted.filter(command => {
    const inputFiles = verifierCommandInputFiles(input.projectRoot, command, input.fs)
      .filter(file => file !== 'package.json')
    if (inputFiles.length === 0) return false
    return inputFiles.some(file => {
      const content = readVerifierCommandInput(input.projectRoot, file, input.fs)
      return content !== null && specMatchesContent({
        projectRoot: input.projectRoot,
        inputFile: file,
        content,
        spec,
        fs: input.fs,
      })
    })
  })
}

function bindRelevanceWitness(
  criterion: AcceptanceRequirementV1,
  command: string,
  defaultWorkingDirectory?: string,
  existingVerifierInputFiles?: readonly string[],
): AcceptanceRequirementV1 {
  const verification = materializeExecutableVerification(
    command,
    defaultWorkingDirectory,
    existingVerifierInputFiles,
  )
  if (!verification) return criterion
  return {
    ...criterion,
    type: requirementTypeForCommand(command),
    verification_strategy: `The task names an observable behavior and its frozen verifier input exercises that same target; this is the ${RELEVANCE_WITNESS_MARKER} for the requirement.`,
    verification,
  }
}

/** Meaning-derived (inferred) executable criteria, e.g. relevance or witness bindings. */
export function contractMeaningVerifierCommands(
  acceptance: readonly AcceptanceRequirementV1[],
): string[] {
  const commands = new Set<string>()
  for (const requirement of acceptance) {
    const strategy = requirement.verification_strategy
    if (!strategy.includes(RELEVANCE_WITNESS_MARKER) &&
      !strategy.includes(WITNESS_STRATEGY_MARKER)) continue
    const command = canonicalCommandFromFrozenVerification(requirement.verification)
    if (command) commands.add(command)
  }
  return [...commands].sort()
}

/** Commands frozen for relevance-bound inferred goals. */
export function relevanceBoundVerifierCommands(meaning: TaskAcceptanceMeaning): string[] {
  const commands = new Set<string>()
  for (const criterion of meaning.criteria) {
    if (!criterion.verification_strategy.includes(RELEVANCE_WITNESS_MARKER)) continue
    const command = canonicalCommandFromFrozenVerification(criterion.verification)
    if (command) commands.add(command)
  }
  return [...commands].sort()
}

/** Protected inputs contributed by relevance-bound inferred goals. */
export function relevanceBoundVerifierInputFiles(
  projectRoot: string,
  meaning: TaskAcceptanceMeaning,
  fs: VerifierCommandInputOverrides = {},
): string[] {
  const files = new Set<string>()
  for (const criterion of meaning.criteria) {
    if (!criterion.verification_strategy.includes(RELEVANCE_WITNESS_MARKER)) continue
    const command = canonicalCommandFromFrozenVerification(criterion.verification)
    if (!command) continue
    for (const file of verifierCommandInputFiles(projectRoot, command, fs)) files.add(file)
  }
  return [...files].sort()
}

/**
 * Bind session-trusted verifier commands onto explicit observable criteria before freeze.
 * A preservation criterion whose own text designates the regression witness may then
 * re-freeze the already-explicit command. Inferred/unresolved meaning stays fail-closed
 * (meaning:* verifier ids) in every other case.
 */
export function bindExecutableVerifiersToTaskAcceptance(input: {
  meaning: TaskAcceptanceMeaning
  trustedVerifierCommands: readonly string[]
  defaultWorkingDirectory?: string
  /** Existing test input paths frozen at session admission; new tests cannot self-certify. */
  existingVerifierInputFiles?: readonly string[]
  /**
   * Live project root. When present, an inferred behavioral goal may bind a
   * trusted verifier only if that verifier's frozen inputs actually exercise
   * the goal's named target/behavior. Replay/amendment callers omit it, so the
   * binding stays deterministic from recorded contract data alone.
   */
  projectRoot?: string
  relevanceFs?: VerifierCommandInputOverrides
}): TaskAcceptanceMeaning {
  const trusted = [
    ...new Set(
      input.trustedVerifierCommands
        .map((command) => command.trim())
        .filter((command) => command.length > 0),
    ),
  ]
  if (trusted.length === 0 || input.meaning.unresolved) return input.meaning

  const bindingProvenance: TaskAcceptanceMeaning['provenance'] = []
  const explicitBound = input.meaning.criteria.map((criterion) => {
    const command = pickTrustedCommand(criterion, trusted, input.meaning.sources)
    if (!command) return criterion
    const bound = bindCriterion(criterion, command, input.defaultWorkingDirectory, input.existingVerifierInputFiles)
    if (bound.verification.verifier_id === criterion.verification.verifier_id) return criterion
    bindingProvenance.push({
      kind: 'derived_acceptance',
      ref: `${ACCEPTANCE_EXECUTABLE_BINDING_REF}:${sha256Canonical({
        criterion_id: criterion.id,
        command,
      }).slice(0, 32)}`,
    })
    return bound
  })

  // V3 is the current admission format. V1/V2 replay semantics stay frozen:
  // their archived criteria cannot gain a new task-authored link on reload.
  if (input.meaning.interpretation_version >= 3) {
    const linked = input.meaning.criteria.flatMap((criterion) => {
      const source = input.meaning.sources.find(item => item.criterion_id === criterion.id)
      if (source?.status !== 'explicit') return []
      const link = explicitCriterionVerifierLink(criterion)
      if (!link) return []
      return [{ criterionId: criterion.id, ...link }]
    })
    const linksByBehavior = new Map<string, typeof linked>()
    for (const link of linked) {
      const key = normalizedCriterionText(link.behavior)
      linksByBehavior.set(key, [...(linksByBehavior.get(key) ?? []), link])
    }
    for (const [behaviorKey, candidates] of linksByBehavior) {
      const commands = new Set(candidates.map(candidate =>
        structuredCommandIdentity(candidate.command) ?? `raw:${candidate.command.trim().replace(/\s+/g, ' ')}`,
      ))
      // Conflicting or duplicate link declarations are ambiguous and do not
      // authorize either executable for the behavior.
      if (commands.size !== 1) continue
      const designated = candidates[0]!
      const command = trustedDesignation(designated, trusted)
      if (!command) continue
      const matchingCriteria = input.meaning.criteria.filter((criterion) => {
        if (criterion.id === designated.criterionId) return true
        const source = input.meaning.sources.find(item => item.criterion_id === criterion.id)
        return source?.status === 'inferred' &&
          normalizedCriterionText(criterion.description) === behaviorKey
      })
      for (const criterion of matchingCriteria) {
        const bound = bindExplicitCriterionLink(
          criterion,
          command,
          designated.behavior,
          input.defaultWorkingDirectory,
          input.existingVerifierInputFiles,
        )
        if (bound.verification.verifier_id === criterion.verification.verifier_id) continue
        const existingIndex = explicitBound.findIndex(item => item.id === criterion.id)
        if (existingIndex >= 0) explicitBound[existingIndex] = bound
        bindingProvenance.push({
          kind: 'derived_acceptance',
          ref: `${CRITERION_VERIFIER_LINK_REF}:${sha256Canonical({
            source_criterion_id: designated.criterionId,
            criterion_id: criterion.id,
            behavior: designated.behavior,
            command,
          }).slice(0, 32)}`,
        })
      }
    }
  }

  // Relevance pass: an inferred behavioral goal may bind a trusted verifier
  // only when its frozen input actually exercises the goal's named target and
  // observable call. A live project root is required; replay/amendment callers
  // omit it and stay deterministic from recorded contract data.
  let relevanceBound = explicitBound
  if (input.projectRoot && input.meaning.interpretation_version >= 3) {
    const projectRoot = input.projectRoot
    const fs = input.relevanceFs ?? {}
    relevanceBound = explicitBound.map((criterion) => {
      const matches = relevantTrustedCommands({ criterion, trusted, projectRoot, fs })
      if (matches.length !== 1) return criterion
      const command = matches[0]!
      const bound = bindRelevanceWitness(
        criterion,
        command,
        input.defaultWorkingDirectory,
        input.existingVerifierInputFiles,
      )
      if (bound.verification.verifier_id === criterion.verification.verifier_id) return criterion
      bindingProvenance.push({
        kind: 'derived_acceptance',
        ref: `${ACCEPTANCE_RELEVANCE_BINDING_REF}:${sha256Canonical({
          criterion_id: criterion.id,
          command,
        }).slice(0, 32)}`,
      })
      return bound
    })
  }

  // Second pass sees the frozen explicit commands, so a witness can only
  // re-freeze what the first pass already froze — never a new command. Each
  // inferred criterion resolves from its own designated command; a criterion
  // whose designation was never explicitly frozen stays fail-closed.
  const witnessEligible =
    input.meaning.structurallyComplete &&
    extractDesignatedRegressionWitness(input.meaning.activeProse) !== null
  let criteria = relevanceBound
  if (witnessEligible) {
    const witnessed = relevanceBound.map((criterion) =>
      bindDesignatedWitnessToCriterion(criterion, input.meaning.sources, explicitBound),
    )
    criteria = relevanceBound.map((criterion, index) => witnessed[index] ?? criterion)
    for (const [index, bound] of witnessed.entries()) {
      if (!bound) continue
      const designated = criterionDesignatedCommand(input.meaning.criteria[index]!.description)
      bindingProvenance.push({
        kind: 'derived_acceptance',
        ref: `${ACCEPTANCE_EXECUTABLE_BINDING_REF}:witness:${sha256Canonical({
          criterion_id: input.meaning.criteria[index]!.id,
          command: designated ?? '',
        }).slice(0, 32)}`,
      })
    }
  }

  if (input.projectRoot && input.meaning.interpretation_version >= 3) {
    const advisory = markAdvisoryDocsGoals({
      criteria,
      sources: input.meaning.sources,
      projectRoot: input.projectRoot,
    })
    if (advisory.criteria !== criteria) {
      criteria = advisory.criteria
      for (const ref of advisory.refs) {
        bindingProvenance.push({ kind: 'derived_acceptance', ref })
      }
    }
  }

  // The preservation sentence is enforced by the frozen export surface at
  // completion; it must not also become an unsatisfiable prose requirement.
  if (input.projectRoot && criteria.some(criterion => criterion.required &&
    isPublicApiPreservationStatement(criterion.description))) {
    criteria = criteria.map(criterion => criterion.required &&
      isPublicApiPreservationStatement(criterion.description)
      ? { ...criterion, required: false, verification_strategy: PUBLIC_API_PRESERVATION_STRATEGY }
      : criterion)
  }

  if (!bindingProvenance.length) return input.meaning
  return {
    ...input.meaning,
    criteria,
    provenance: [...input.meaning.provenance, ...bindingProvenance],
  }
}

const WITNESS_STRATEGY_MARKER = 'regression witness for this preservation requirement'

/** Criteria whose preservation obligation was bound to its own designated witness. */
function witnessBoundCriteria(meaning: TaskAcceptanceMeaning): AcceptanceRequirementV1[] {
  return meaning.criteria.filter(
    (criterion) =>
      !criterion.verification.verifier_id.startsWith('meaning:') &&
      criterion.verification_strategy.includes(WITNESS_STRATEGY_MARKER),
  )
}

/** True when the binding froze a designated regression witness for this meaning. */
export function hasDesignatedRegressionWitnessBinding(meaning: TaskAcceptanceMeaning): boolean {
  return witnessBoundCriteria(meaning).length > 0
}

/**
 * The designated commands of witness-bound criteria, parsed from each
 * criterion's own description. Feeds the narrowly declared protected-input set
 * (script definition surface plus resolvable test files) captured at freeze.
 */
export function designatedWitnessCommands(meaning: TaskAcceptanceMeaning): string[] {
  const commands: string[] = []
  for (const criterion of witnessBoundCriteria(meaning)) {
    const command = criterionDesignatedCommand(criterion.description)
    if (command) commands.push(command)
  }
  return commands
}

export function mergeTrustedVerifierCommands(input: {
  requiredVerifierCommands?: readonly string[] | null
  projectTestCommands?: readonly string[] | null
}): string[] {
  return [
    ...new Set(
      [
        ...(input.requiredVerifierCommands ?? []),
        ...(input.projectTestCommands ?? []),
      ]
        .map((command) => command.trim())
        .filter((command) => command.length > 0),
    ),
  ]
}

/** @deprecated Use criterionExplicitlyNamesTrustedCommand */
export const criterionDescriptionMatchesTrustedCommand = criterionExplicitlyNamesTrustedCommand
