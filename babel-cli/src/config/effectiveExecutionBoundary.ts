/**
 * Effective execution boundary — the one disclosure every surface should use.
 *
 * A selected execution profile is not the same thing as the OS-enforced
 * boundary that will actually apply. This module resolves both from the same
 * decision the executor uses (`evaluateGovernedIsolation`) so doctor, setup,
 * interactive chat and diagnostics cannot describe different authorities.
 *
 * Secrets never enter this module: only profile names and boundary kinds.
 */

import {
  evaluateGovernedIsolation,
  isHostIsolationEscalationAllowed,
  type GovernedIsolationDecision,
} from './benchmarkContainer.js';
import { resolveExecutionProfile, type ExecutionProfileName } from './executionProfiles.js';

/** Ordinary Chat selects host-native when the operator has not selected a profile. */
export const ORDINARY_CHAT_EXECUTION_PROFILE: ExecutionProfileName = 'host_native';

export type EffectiveBoundaryKind =
  | 'docker'
  | 'host_native'
  | 'host_profile'
  | 'host_escalated'
  | 'unavailable';

export interface EffectiveExecutionBoundary {
  profile: ExecutionProfileName;
  /** Boundary the profile requires, independent of what is currently available. */
  requiredBoundary: 'host' | 'docker';
  /** Boundary actually in force for the next command. */
  boundary: EffectiveBoundaryKind;
  /** Who holds filesystem/network authority for eligible commands. */
  authority: 'container' | 'host_os_user';
  /** Whether the operator explicitly waived a required container boundary. */
  escalation: boolean;
  /** True when the profile cannot execute at all until setup is repaired. */
  failClosed: boolean;
  /** One-line, secret-free disclosure suitable for human output. */
  disclosure: string;
}

export interface EffectiveExecutionBoundaryInput {
  /** Explicit selection; otherwise BABEL_EXECUTION_PROFILE; otherwise ordinary Chat default. */
  profile?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  dockerImage?: string | null | undefined;
  /** Pre-computed decision (diagnostics that inject their own Docker probes). */
  decision?: GovernedIsolationDecision;
}

function selectedProfile(input: EffectiveExecutionBoundaryInput): ExecutionProfileName {
  const env = input.env ?? process.env;
  const configured = input.profile ?? env['BABEL_EXECUTION_PROFILE'];
  return configured === null || configured === undefined
    ? ORDINARY_CHAT_EXECUTION_PROFILE
    : resolveExecutionProfile(configured).name;
}

function escalationSource(env: NodeJS.ProcessEnv): string | null {
  if (!isHostIsolationEscalationAllowed(env)) return null;
  const fallback = String(env['BABEL_ALLOW_HOST_FALLBACK'] ?? '').trim().toLowerCase();
  if (fallback === '1' || fallback === 'true' || fallback === 'yes') {
    return 'BABEL_ALLOW_HOST_FALLBACK';
  }
  return env['BABEL_DOCKER_DISABLE'] === 'true' ? 'BABEL_DOCKER_DISABLE' : null;
}

/**
 * Resolve the effective boundary from the same governed decision the executor
 * uses. Pure with respect to inputs it is given; Docker availability is the
 * process's cached probe (injectable through the benchmark test seam).
 */
export function resolveEffectiveExecutionBoundary(
  input: EffectiveExecutionBoundaryInput = {},
): EffectiveExecutionBoundary {
  const env = input.env ?? process.env;
  const profile = resolveExecutionProfile(selectedProfile(input));
  const requiredBoundary = profile.dockerSandbox ? 'docker' : 'host';
  const decision = input.decision ?? evaluateGovernedIsolation(profile.name, input.dockerImage, env);

  if (decision.kind === 'docker') {
    return {
      profile: profile.name,
      requiredBoundary,
      boundary: 'docker',
      authority: 'container',
      escalation: false,
      failClosed: false,
      disclosure:
        `Execution boundary: container (Docker) for profile "${profile.name}". ` +
        'Running eligible repository commands requires a usable sandbox image. Those commands run inside Docker, outside host credential stores.',
    };
  }

  if (decision.kind === 'host_escalated') {
    const source = escalationSource(env) ?? 'an explicit operator switch';
    return {
      profile: profile.name,
      requiredBoundary,
      boundary: 'host_escalated',
      authority: 'host_os_user',
      escalation: true,
      failClosed: false,
      disclosure:
        `Execution boundary: host (escalated) for profile "${profile.name}". ` +
        `Container isolation was explicitly waived by ${source}; commands run with your OS user's filesystem and network authority. ` +
        'This is not an OS sandbox and cannot protect user credential files from arbitrary command code.',
    };
  }

  if (decision.kind === 'fail_closed') {
    return {
      profile: profile.name,
      requiredBoundary,
      boundary: 'unavailable',
      authority: 'container',
      escalation: false,
      failClosed: true,
      disclosure:
        `Execution boundary: unavailable for profile "${profile.name}". ` +
        'Project commands fail closed until Docker and a usable sandbox image are configured; they do not fall back to this machine.',
    };
  }

  if (profile.name === ORDINARY_CHAT_EXECUTION_PROFILE) {
    return {
      profile: profile.name,
      requiredBoundary,
      boundary: 'host_native',
      authority: 'host_os_user',
      escalation: false,
      failClosed: false,
      disclosure:
        `Execution boundary: host-native for profile "${profile.name}". ` +
        "Eligible project commands run with your OS user's filesystem and network authority. " +
        'This is not an OS sandbox and cannot protect user credential files from arbitrary command code. ' +
        'Select a container profile such as safe_repo for an enforced boundary.',
    };
  }

  return {
    profile: profile.name,
    requiredBoundary,
    boundary: 'host_profile',
    authority: 'host_os_user',
    escalation: false,
    failClosed: false,
    disclosure:
      `Execution boundary: host-local for profile "${profile.name}" (no Docker isolation). ` +
      "Eligible commands run with your OS user's authority under this profile's command policy; " +
      'this is not an OS sandbox.',
  };
}

/** True when the ambient environment silently widens a container profile onto the host. */
export function hasHostIsolationEscalation(env: NodeJS.ProcessEnv = process.env): boolean {
  return escalationSource(env) !== null;
}
