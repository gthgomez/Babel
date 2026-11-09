import { sha256Canonical } from '../acceptance/canonical.js'
import {
  explicitNodeTestFileArgs,
  isAuthoritativeVerifierCommand,
  parseStructuredVerifierCommand,
} from './completionGatePolicy.js'
import type { AcceptanceRequirementV1, AcceptanceRequirementType } from './taskContract.js'
import type { AcceptanceMeaningSource, TaskAcceptanceMeaning } from './taskAcceptanceMeaning.js'
import { analyzeVerifierIdentity } from '../services/verifierIdentity.js'

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

function normalizeCommandText(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase()
}

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

/** Trusted and criterion commands must match exact parsed argv (no alias or prefix weakening). */
export function commandsMatchForExecutableBinding(
  criterionCommand: string,
  trustedCommand: string,
): boolean {
  const left = structuredCommandIdentity(criterionCommand)
  const right = structuredCommandIdentity(trustedCommand)
  if (!left || !right) return false
  if (left !== right) return false
  return normalizeCommandText(criterionCommand) === normalizeCommandText(trustedCommand)
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
  // This key decides whether a verifier explicitly designated for one
  // behavioral statement may also prove an inferred opening goal. Normalize
  // prose whitespace, but preserve quoted literals byte-for-byte: spaces
  // inside strings are observable just like case-sensitive identifiers.
  const text = value.trim().replace(/[.!?]+$/, '')
  let output = ''
  let quote = ''
  let escaped = false
  let pendingSpace = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    // Regex literals are executable behavior too. Preserve their exact bytes,
    // including repeated spaces; slash-delimited prose/path fragments are
    // conservatively preserved when they have a valid closing delimiter.
    if (char === '/' && text[index + 1] !== '/') {
      let end = index + 1
      let inCharacterClass = false
      let regexEscape = false
      for (; end < text.length; end++) {
        const candidate = text[end]!
        if (regexEscape) { regexEscape = false; continue }
        if (candidate === '\\') { regexEscape = true; continue }
        if (candidate === '[') { inCharacterClass = true; continue }
        if (candidate === ']') { inCharacterClass = false; continue }
        if (candidate === '/' && !inCharacterClass) break
      }
      if (end < text.length) {
        if (pendingSpace && output) output += ' '
        pendingSpace = false
        output += text.slice(index, end + 1)
        index = end
        while (/[a-z]/i.test(text[index + 1] ?? '')) output += text[++index]
        continue
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      if (pendingSpace && output) output += ' '
      pendingSpace = false
      quote = char
      output += char
    } else if (/\s/.test(char)) {
      pendingSpace = true
    } else {
      if (pendingSpace && output) output += ' '
      pendingSpace = false
      output += char
    }
  }
  return output.trim()
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

  // Second pass sees the frozen explicit commands, so a witness can only
  // re-freeze what the first pass already froze — never a new command. Each
  // inferred criterion resolves from its own designated command; a criterion
  // whose designation was never explicitly frozen stays fail-closed.
  const witnessEligible =
    input.meaning.structurallyComplete &&
    extractDesignatedRegressionWitness(input.meaning.activeProse) !== null
  let criteria = explicitBound
  if (witnessEligible) {
    const witnessed = explicitBound.map((criterion) =>
      bindDesignatedWitnessToCriterion(criterion, input.meaning.sources, explicitBound),
    )
    criteria = explicitBound.map((criterion, index) => witnessed[index] ?? criterion)
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
