/**
 * V0–V3 verification stages. Acceptance cannot be `cat`/`type`.
 * Stale verification cannot authorize VERIFIED_COMPLETE.
 */

export type VerificationStage = 'V0' | 'V1' | 'V2' | 'V3'
export type RiskLevel = 'low' | 'medium' | 'high'

export interface VerificationCommandClass {
  stage: VerificationStage | 'invalid'
  isCatOrType: boolean
  isMeaningful: boolean
  reason: string
}

export interface RiskProfile {
  filesChanged: number
  publicApiChanged: boolean
  sharedCoreTouched: boolean
  securitySensitive: boolean
  configOrBuildChanged: boolean
  dependencyChanged: boolean
  refactorBreadth: boolean
}

/**
 * Classify a shell/test command into a verification stage.
 */
export function classifyVerificationCommand(command: string): VerificationCommandClass {
  const cmd = command.trim()
  if (!cmd) {
    return { stage: 'invalid', isCatOrType: false, isMeaningful: false, reason: 'empty command' }
  }
  if (isCatOrTypeCommand(cmd)) {
    return {
      stage: 'invalid',
      isCatOrType: true,
      isMeaningful: false,
      reason: 'cat/type only proves the file is readable, not correctness',
    }
  }
  if (isEchoOrTypeProbe(cmd)) {
    return {
      stage: 'invalid',
      isCatOrType: false,
      isMeaningful: false,
      reason: 'echo/type probe is not a verifier',
    }
  }
  if (/tsc\b|typecheck|vue-tsc|pyright|mypy/i.test(cmd)) {
    return { stage: 'V1', isCatOrType: false, isMeaningful: true, reason: 'targeted typecheck' }
  }
  if (/\b(pytest|npm test|npx vitest|jest|go test|cargo test|gradle test|mvn test)\b/i.test(cmd)) {
    if (/--testpath|--run | -t | -g | -k | --testNamePattern|path[: ]/i.test(cmd) || /\.test\.|\.spec\./i.test(cmd)) {
      return { stage: 'V1', isCatOrType: false, isMeaningful: true, reason: 'targeted test' }
    }
    return { stage: 'V2', isCatOrType: false, isMeaningful: true, reason: 'acceptance / suite test' }
  }
  if (/\b(npm run build|cargo build|go build|gradlew |mvn package|webpack|vite build)\b/i.test(cmd)) {
    return { stage: 'V3', isCatOrType: false, isMeaningful: true, reason: 'build / regression' }
  }
  if (/\b(npm run lint|eslint|ruff |clippy|prettier --check)\b/i.test(cmd)) {
    return { stage: 'V3', isCatOrType: false, isMeaningful: true, reason: 'lint regression' }
  }
  if (/\bnode\b.+\.test\.|\bpython\b.+\.py\b/i.test(cmd) && !/ -c /.test(cmd)) {
    return { stage: 'V1', isCatOrType: false, isMeaningful: true, reason: 'direct test file' }
  }
  return { stage: 'V1', isCatOrType: false, isMeaningful: true, reason: 'generic command treated as targeted' }
}

export function isCatOrTypeCommand(command: string): boolean {
  const cmd = command.trim()
  if (/^(cat|type|Get-Content|gc)\b/i.test(cmd) && !/\|\s*(pytest|npm|node|go|cargo)/i.test(cmd)) {
    return true
  }
  // `type file` on Windows; allow `type` as a PowerShell type accelerator only with ::
  if (/^type\s+\S+/i.test(cmd) && !/type::/i.test(cmd)) return true
  return false
}

export function isEchoOrTypeProbe(command: string): boolean {
  return /^(echo|Write-Output|Write-Host)\b/i.test(command.trim())
}

/**
 * Risk-proportional required stages. High-risk diffs must broaden past V1.
 */
export function requiredStagesForRisk(profile: RiskProfile): VerificationStage[] {
  const risk = riskLevelFromProfile(profile)
  if (risk === 'high') return ['V1', 'V2', 'V3']
  if (risk === 'medium') return ['V1', 'V2']
  return ['V1']
}

export function riskLevelFromProfile(profile: RiskProfile): RiskLevel {
  let score = 0
  if (profile.filesChanged >= 5) score += 2
  else if (profile.filesChanged >= 3) score += 1
  if (profile.publicApiChanged) score += 2
  if (profile.sharedCoreTouched) score += 2
  if (profile.securitySensitive) score += 3
  if (profile.configOrBuildChanged) score += 2
  if (profile.dependencyChanged) score += 2
  if (profile.refactorBreadth) score += 2
  if (score >= 5) return 'high'
  if (score >= 2) return 'medium'
  return 'low'
}

export interface VerifiedCompleteAuthorization {
  allow: boolean
  reason: string
}

/**
 * Controller-owned completion honesty for verification stages.
 */
export function canAuthorizeVerifiedComplete(input: {
  stagesCompleted: VerificationStage[]
  lastReceiptFresh: boolean
  lastReceiptGreen: boolean
  acceptanceCommand?: string
  risk: RiskLevel
  criticFailed?: boolean
}): VerifiedCompleteAuthorization {
  if (input.criticFailed) {
    return { allow: false, reason: 'critic_failure_cannot_mint_verified_success' }
  }
  if (!input.lastReceiptGreen) {
    return { allow: false, reason: 'verifier_red' }
  }
  if (!input.lastReceiptFresh) {
    return { allow: false, reason: 'stale_verification_cannot_authorize_VERIFIED_COMPLETE' }
  }
  if (input.acceptanceCommand !== undefined) {
    const classified = classifyVerificationCommand(input.acceptanceCommand)
    if (classified.isCatOrType || !classified.isMeaningful) {
      return { allow: false, reason: 'acceptance_verifier_not_meaningful' }
    }
  }
  if (input.risk === 'high' && !input.stagesCompleted.includes('V3')) {
    return { allow: false, reason: 'high_risk_requires_V3' }
  }
  if ((input.risk === 'medium' || input.risk === 'high') && !input.stagesCompleted.includes('V2')) {
    return { allow: false, reason: 'acceptance_V2_required' }
  }
  if (!input.stagesCompleted.includes('V1') && !input.stagesCompleted.includes('V2')) {
    return { allow: false, reason: 'no_targeted_or_acceptance_verifier' }
  }
  return { allow: true, reason: 'ok' }
}

/**
 * Distinguish baseline (pre-mutation) failure from a patch-induced failure.
 */
export function classifyFailureOrigin(input: {
  baselineExitCode?: number
  baselineSignature?: string
  currentExitCode: number
  currentSignature: string
}): 'pre_existing' | 'already_fixed' | 'environment' | 'patch_induced' | 'unknown' {
  if (input.baselineExitCode === 0 && input.currentExitCode !== 0) return 'patch_induced'
  if (input.baselineExitCode !== undefined && input.baselineExitCode !== 0 && input.currentExitCode === 0) {
    return 'already_fixed'
  }
  if (
    input.baselineSignature &&
    input.currentSignature &&
    input.baselineSignature === input.currentSignature &&
    input.currentExitCode !== 0
  ) {
    return 'pre_existing'
  }
  if (input.baselineExitCode === undefined) return 'unknown'
  return 'unknown'
}
