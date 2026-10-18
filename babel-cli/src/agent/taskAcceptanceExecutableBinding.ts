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

function requirementTypeForCommand(command: string): AcceptanceRequirementType {
  const identity = analyzeVerifierIdentity(command)
  const lower = command.toLowerCase()
  if (/typecheck|tsc\b/.test(lower)) return 'typecheck'
  if (/\blint\b/.test(lower)) return 'lint'
  if (/\bbuild\b/.test(lower)) return 'build'
  if (identity?.family.includes('test') || /\btest\b/.test(lower)) return 'unit_test'
  return 'custom'
}

function normalizedWords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean)
}

/** Whether observable prose plausibly refers to this trusted verifier command. */
export function criterionDescriptionMatchesTrustedCommand(
  description: string,
  command: string,
): boolean {
  const desc = normalizedWords(description)
  const cmd = command.toLowerCase()
  if (desc.some((word) => cmd.includes(word) && word.length >= 3)) return true
  const identity = analyzeVerifierIdentity(command)
  if (identity?.family === 'npm-test' || /\btest\b/.test(cmd)) {
    return desc.some((word) =>
      ['test', 'tests', 'suite', 'parser', 'npm'].includes(word),
    )
  }
  if (/\bbuild\b/.test(cmd)) return desc.includes('build')
  if (/\blint\b/.test(cmd)) return desc.includes('lint')
  if (/typecheck|tsc\b/.test(cmd)) return desc.includes('typecheck') || desc.includes('types')
  return false
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
    criterionDescriptionMatchesTrustedCommand(criterion.description, command),
  )
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) return null

  const explicitCriteria = explicitOnly.filter((item) => item.status === 'explicit')
  if (explicitCriteria.length === 1 && commands.length === 1) return commands[0]!

  return null
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
