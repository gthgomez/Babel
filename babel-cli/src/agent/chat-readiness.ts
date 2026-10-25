import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { evaluateGovernedIsolation, type GovernedIsolationDecision } from '../config/benchmarkContainer.js'
import { resolveIsolationBrokerFlags } from './chatEngineIsolationFlags.js'
import type { PrerequisiteLedger } from '../runtime/prerequisite-ledger.js'

export interface CapabilityReadiness {
  capabilityId: string
  resource: string
  ready: boolean
  reasonCode?: string
  remediation?: string
  prerequisiteKey?: string
  revision: string
}

export interface ChatReadinessInput {
  projectRoot: string
  env?: NodeJS.ProcessEnv
  /** Paths the task intends to mutate; dirty conflicts block native file edit only. */
  mutationTargets?: readonly string[]
  /** Task requires shell/verifier execution (not file-only). */
  requiresShellExecution?: boolean
  /** Task can complete through native file edit without shell. */
  allowsFileOnlyAlternate?: boolean
  ledger?: PrerequisiteLedger
}

const DEFAULT_CAPABILITIES = ['native_file_edit', 'run_shell', 'sandbox_isolation'] as const


function revisionDigest(parts: Record<string, string | boolean | null>): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 16)
}

function isGitRepository(projectRoot: string): boolean {
  try {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return result.status === 0 && String(result.stdout ?? '').trim() === 'true'
  } catch {
    return false
  }
}

function sandboxReadiness(
  decision: GovernedIsolationDecision,
  env: NodeJS.ProcessEnv,
): CapabilityReadiness {
  const image = (env['BABEL_BENCHMARK_DOCKER_IMAGE'] ?? '').trim()
  const revision = revisionDigest({
    kind: decision.kind,
    image,
    profile: decision.kind === 'host_profile' || decision.kind === 'host_escalated' || decision.kind === 'fail_closed'
      ? (decision as { profile?: string }).profile ?? ''
      : '',
    dockerDisabled: env['BABEL_DOCKER_DISABLE'] === 'true',
  })
  const resource = image || decision.kind
  if (decision.kind === 'docker') {
    return {
      capabilityId: 'sandbox_isolation',
      resource,
      ready: true,
      revision,
    }
  }
  if (decision.kind === 'host_profile' || decision.kind === 'host_escalated') {
    return {
      capabilityId: 'sandbox_isolation',
      resource,
      ready: true,
      revision,
      reasonCode: 'SANDBOX_NOT_REQUIRED',
    }
  }
  const reason =
    decision.kind === 'fail_closed'
      ? (decision as { reason?: string }).reason ?? 'ISOLATION_UNAVAILABLE'
      : 'ISOLATION_UNAVAILABLE'
  return {
    capabilityId: 'sandbox_isolation',
    resource,
    ready: false,
    reasonCode: 'SANDBOX_PROBE_FAILED',
    remediation: reason,
    prerequisiteKey: 'sandbox:isolation',
    revision,
  }
}

function shellReadiness(
  flags: ReturnType<typeof resolveIsolationBrokerFlags>,
  decision: GovernedIsolationDecision,
  env: NodeJS.ProcessEnv,
  inGitRepo: boolean,
): CapabilityReadiness {
  const revision = revisionDigest({
    isolationRequired: flags.isolationRequired,
    isolationAvailable: flags.isolationAvailable,
    hostFallback: flags.hostFallbackAllowed,
    kind: decision.kind,
    inGitRepo,
    profile: env['BABEL_EXECUTION_PROFILE'] ?? '',
  })
  if (!inGitRepo) {
    return {
      capabilityId: 'run_shell',
      resource: 'host',
      ready: false,
      reasonCode: 'NON_GIT_PROJECT_ROOT',
      remediation: 'Shell execution requires a governed Git project root.',
      prerequisiteKey: 'workspace:git-root',
      revision,
    }
  }
  if (decision.kind === 'fail_closed' || (flags.isolationRequired && !flags.isolationAvailable && !flags.hostFallbackAllowed)) {
    return {
      capabilityId: 'run_shell',
      resource: 'host',
      ready: false,
      reasonCode: 'SHELL_ISOLATION_BLOCKED',
      remediation: 'Isolation is required but unavailable; host execution is not authorized.',
      prerequisiteKey: 'shell:isolation',
      revision,
    }
  }
  if (flags.dirtyTree && env['BABEL_REQUIRE_CLEAN_TREE'] === '1') {
    return {
      capabilityId: 'run_shell',
      resource: 'host',
      ready: false,
      reasonCode: 'WORKTREE_DIRTY',
      remediation: 'Clean the working tree or resolve dirty-work policy before shell execution.',
      prerequisiteKey: 'workspace:clean-tree',
      revision,
    }
  }
  return {
    capabilityId: 'run_shell',
    resource: 'host',
    ready: true,
    revision,
  }
}

function fileEditReadiness(
  flags: ReturnType<typeof resolveIsolationBrokerFlags>,
  mutationTargets: readonly string[],
  env: NodeJS.ProcessEnv,
  inGitRepo: boolean,
): CapabilityReadiness {
  const targetKey = mutationTargets.map(p => p.trim()).filter(Boolean).sort().join('|') || '(none)'
  const revision = revisionDigest({
    dirtyTree: flags.dirtyTree,
    targets: targetKey,
    requireClean: env['BABEL_REQUIRE_CLEAN_TREE'] === '1',
    inGitRepo,
  })
  if (!inGitRepo && mutationTargets.length > 0) {
    return {
      capabilityId: 'native_file_edit',
      resource: targetKey,
      ready: false,
      reasonCode: 'NON_GIT_PROJECT_ROOT',
      prerequisiteKey: 'workspace:git-root',
      revision,
    }
  }
  if (flags.dirtyTree && mutationTargets.length === 0) {
    return {
      capabilityId: 'native_file_edit',
      resource: targetKey,
      ready: false,
      reasonCode: 'WORKTREE_DIRTY_UNSAFE',
      remediation: 'Unexpected dirty tree blocks edits until paths are classified.',
      prerequisiteKey: 'workspace:dirty-tree',
      revision,
    }
  }
  return {
    capabilityId: 'native_file_edit',
    resource: targetKey,
    ready: true,
    revision,
  }
}

function syncLedger(ledger: PrerequisiteLedger | undefined, items: CapabilityReadiness[]): void {
  if (!ledger) return
  for (const item of items) {
    if (item.ready || !item.prerequisiteKey) continue
    ledger.record({
      key: item.prerequisiteKey,
      revision: item.revision,
      reasonCode: item.reasonCode ?? 'PREREQUISITE',
      ...(item.remediation ? { remediation: item.remediation } : {}),
    })
  }
}

/** Project capability readiness without changing safe_repo defaults or granting host execution. */
export function evaluateChatReadiness(input: ChatReadinessInput): CapabilityReadiness[] {
  const env = input.env ?? process.env
  const decision = evaluateGovernedIsolation(
    env['BABEL_EXECUTION_PROFILE'],
    env['BABEL_BENCHMARK_DOCKER_IMAGE'] ?? null,
    env,
  )
  const flags = resolveIsolationBrokerFlags(input.projectRoot, env)
  const inGitRepo = isGitRepository(input.projectRoot)
  const mutationTargets = input.mutationTargets ?? []
  const sandbox = sandboxReadiness(decision, env)
  const shell = shellReadiness(flags, decision, env, inGitRepo)
  const fileEdit = fileEditReadiness(flags, mutationTargets, env, inGitRepo)

  if (input.requiresShellExecution && !shell.ready) {
    shell.reasonCode = shell.reasonCode ?? 'SHELL_PREREQUISITE'
  }
  if (input.requiresShellExecution && !shell.ready && !input.allowsFileOnlyAlternate) {
    fileEdit.ready = false
    fileEdit.reasonCode = 'REQUIRED_EXECUTION_PREREQUISITE'
    fileEdit.remediation = 'Task requires shell/verifier execution; file-only work cannot satisfy verification.'
    fileEdit.prerequisiteKey = shell.prerequisiteKey ?? 'shell:execution'
    fileEdit.revision = shell.revision
  }
  if (input.allowsFileOnlyAlternate && !shell.ready && fileEdit.ready) {
    delete fileEdit.reasonCode
    delete fileEdit.remediation
  }

  const results: CapabilityReadiness[] = [sandbox, shell, fileEdit]
  syncLedger(input.ledger, results)
  return results.filter(item => DEFAULT_CAPABILITIES.includes(item.capabilityId as typeof DEFAULT_CAPABILITIES[number]))
}

export function readinessByCapability(
  items: readonly CapabilityReadiness[],
  capabilityId: string,
): CapabilityReadiness | undefined {
  return items.find(item => item.capabilityId === capabilityId)
}
