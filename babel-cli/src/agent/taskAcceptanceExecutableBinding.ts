import { sha256Canonical } from '../acceptance/canonical.js'
import {
  isAuthoritativeVerifierCommand,
  parseStructuredVerifierCommand,
} from './completionGatePolicy.js'
import type { AcceptanceRequirementV1, AcceptanceRequirementType } from './taskContract.js'
import type { AcceptanceMeaningSource, TaskAcceptanceMeaning } from './taskAcceptanceMeaning.js'
import { analyzeVerifierIdentity, satisfiesVerifierRequirement } from '../services/verifierIdentity.js'

function isUnresolvedCriterion(criterion: AcceptanceRequirementV1): boolean {
  return (
    criterion.verification.verifier_id.startsWith('meaning:') &&
    criterion.verification_strategy.includes('unresolved')
  )
}

export const ACCEPTANCE_EXECUTABLE_BINDING_REF = 'task-acceptance-executable-binding:v1'

const VAGUE_ACCEPTANCE_TOKENS = new Set([
  'fix',
  'parser',
  'test',
  'tests',
  'suite',
  'project',
  'pass',
  'passes',
  'green',
  'verify',
  'requirements',
  'requirement',
  'acceptance',
])

function normalizeCommandText(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase()
}

function quotedCommandsInDescription(description: string): string[] {
  const out: string[] = []
  for (const match of description.matchAll(/`([^`]+)`/g)) {
    const quoted = match[1]?.trim()
    if (quoted) out.push(normalizeCommandText(quoted))
  }
  return out
}

/**
 * True only when the criterion text explicitly names this trusted command (or a
 * quoted/backtick form). Vague words like "tests", "parser", or "fix" never bind.
 */
export function criterionExplicitlyNamesTrustedCommand(
  description: string,
  command: string,
): boolean {
  const normalizedCommand = normalizeCommandText(command)
  if (!normalizedCommand) return false

  const normalizedDescription = description.toLowerCase()
  if (normalizedDescription.includes(normalizedCommand)) return true

  for (const quoted of quotedCommandsInDescription(description)) {
    if (quoted === normalizedCommand) return true
    if (satisfiesVerifierRequirement(normalizedCommand, quoted)) return true
    if (satisfiesVerifierRequirement(quoted, normalizedCommand)) return true
  }

  // Reject criteria whose only overlap with the command is vague vocabulary.
  const descWords = normalizedDescription
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (descWords.every((word) => VAGUE_ACCEPTANCE_TOKENS.has(word) || word.length < 3)) {
    return false
  }

  return false
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
