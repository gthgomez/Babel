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

export const ACCEPTANCE_EXECUTABLE_BINDING_REF = 'task-acceptance-executable-binding:v1'

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
 * Bind session-trusted verifier commands onto explicit observable criteria before freeze.
 * Inferred/unresolved meaning stays fail-closed (meaning:* verifier ids).
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
  const criteria = input.meaning.criteria.map((criterion) => {
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
