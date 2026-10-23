import { sha256Canonical } from '../acceptance/canonical.js'
import {
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
): AcceptanceRequirementV1['verification'] | null {
  if (!isAuthoritativeVerifierCommand(command)) return null
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
): AcceptanceRequirementV1 {
  const verification = materializeExecutableVerification(command, defaultWorkingDirectory)
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

function designatedRegressionWitness(
  meaning: TaskAcceptanceMeaning,
  trusted: readonly string[],
): { command: string; verification: AcceptanceRequirementV1['verification'] } | null {
  if (!meaning.structurallyComplete) return null
  const designated = extractDesignatedRegressionWitness(meaning.activeProse)
  if (!designated) return null
  if (!isAuthoritativeVerifierCommand(designated)) return null
  const parsed = parseStructuredVerifierCommand(designated, {
    authoritySource: 'built_in_runner',
  })
  if (!parsed || parsed.authoritySource !== 'built_in_runner') return null
  if (!trusted.some((command) => commandsMatchForExecutableBinding(designated, command))) {
    return null
  }
  const identity = structuredCommandIdentity(designated)
  if (!identity) return null
  const frozen = new Map<string, AcceptanceRequirementV1['verification']>()
  for (const criterion of meaning.criteria) {
    const frozenIdentity = frozenVerificationIdentity(criterion.verification)
    if (frozenIdentity && frozenIdentity === identity) {
      frozen.set(frozenIdentity, criterion.verification)
    }
  }
  if (frozen.size !== 1) return null
  return { command: designated, verification: [...frozen.values()][0]! }
}

function bindDesignatedWitnessToCriterion(
  criterion: AcceptanceRequirementV1,
  sources: readonly AcceptanceMeaningSource[],
  witness: { command: string; verification: AcceptanceRequirementV1['verification'] },
): AcceptanceRequirementV1 | null {
  if (!criterion.verification.verifier_id.startsWith('meaning:')) return null
  if (isUnresolvedCriterion(criterion)) return null
  const source = sources.find((item) => item.criterion_id === criterion.id)
  if (!source || source.status !== 'inferred') return null
  // The obligation's own text must carry the preservation claim and the
  // designation; surrounding prose never binds a criterion it does not describe.
  if (!PRESERVATION_MARKER_RE.test(criterion.description)) return null
  if (!TESTS_ALREADY_PRESENT_RE.test(criterion.description)) return null
  if (!DESIGNATED_TEST_COMMAND_RE.test(criterion.description)) return null
  return {
    ...criterion,
    type: requirementTypeForCommand(witness.command),
    verification_strategy: `The task text designates ${witness.command} as the regression witness for this preservation requirement; the already-present regression tests must stay unchanged and pass on the candidate revision.`,
    verification: structuredClone(witness.verification),
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
    const bound = bindCriterion(criterion, command, input.defaultWorkingDirectory)
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

  // Second pass sees the frozen explicit command, so the witness can only
  // re-freeze what the first pass already froze — never a new command.
  const witness = designatedRegressionWitness(
    { ...input.meaning, criteria: explicitBound },
    trusted,
  )
  let criteria = explicitBound
  if (witness) {
    const witnessed = explicitBound.map((criterion) =>
      bindDesignatedWitnessToCriterion(criterion, input.meaning.sources, witness),
    )
    criteria = explicitBound.map((criterion, index) => witnessed[index] ?? criterion)
    for (const [index, bound] of witnessed.entries()) {
      if (!bound) continue
      bindingProvenance.push({
        kind: 'derived_acceptance',
        ref: `${ACCEPTANCE_EXECUTABLE_BINDING_REF}:witness:${sha256Canonical({
          criterion_id: input.meaning.criteria[index]!.id,
          command: witness.command,
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
