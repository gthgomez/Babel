import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExecutionProfile, type ExecutionProfileName } from './executionProfiles.js';
import type { GovernedIsolationDecision } from './benchmarkContainer.js';

export type ExecutionBoundary = 'host' | 'docker';
export type ExecutionPolicySource = 'explicit' | 'environment' | 'default' | 'migration';

/** Credential-free, versioned evidence of a session's effective boundary. */
export interface PersistedExecutionPolicy {
  version: 1;
  profile: ExecutionProfileName;
  source: ExecutionPolicySource;
  effectiveBoundary: ExecutionBoundary;
}

export interface ExecutionPolicyChoice {
  profile: ExecutionProfileName;
  source: ExecutionPolicySource | 'persisted';
  expectedBoundary?: ExecutionBoundary;
}

export interface ExecutionPolicyChoiceInput {
  /** Set only for a user selection, not a UI-generated default argument. */
  explicitProfile?: string;
  environmentProfile?: string;
  defaultProfile?: string;
  resume?: boolean;
  persisted?: unknown;
}

function readPersistedPolicy(value: unknown): PersistedExecutionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted execution policy.');
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1 || typeof record['profile'] !== 'string' ||
      typeof record['source'] !== 'string' ||
      !['explicit', 'environment', 'default', 'migration'].includes(record['source']) ||
      typeof record['effectiveBoundary'] !== 'string' ||
      !['host', 'docker'].includes(record['effectiveBoundary'])) {
    throw new Error('Invalid persisted execution policy.');
  }
  let profile: ExecutionProfileName;
  try { profile = resolveExecutionProfile(record['profile']).name; }
  catch { throw new Error('Invalid persisted execution policy.'); }
  // Persisted records use canonical names; aliases are only for operator input.
  if (profile !== record['profile']) throw new Error('Invalid persisted execution policy.');
  if (!resolveExecutionProfile(profile).dockerSandbox && record['effectiveBoundary'] === 'docker') {
    throw new Error('Invalid persisted execution policy.');
  }
  return {
    version: 1, profile,
    source: record['source'] as ExecutionPolicySource,
    effectiveBoundary: record['effectiveBoundary'] as ExecutionBoundary,
  };
}

/** Select policy without confusing a missing profile with an invalid value. */
export function resolveExecutionPolicyChoice(input: ExecutionPolicyChoiceInput): ExecutionPolicyChoice {
  // A malformed configured value is an error even if another source wins.
  const environment = input.environmentProfile === undefined
    ? undefined : resolveExecutionProfile(input.environmentProfile).name;
  // Explicit migration is not permission to overwrite a corrupt or unknown
  // authority record. Validate any record before considering a new choice.
  const saved = input.resume && input.persisted !== undefined && input.persisted !== null
    ? readPersistedPolicy(input.persisted) : undefined;
  if (input.explicitProfile !== undefined) {
    return {
      profile: resolveExecutionProfile(input.explicitProfile).name,
      source: input.resume ? 'migration' : 'explicit',
    };
  }
  if (input.resume) {
    if (!saved) {
      throw new Error('This session has no proven execution policy. Select an explicit execution profile before resuming.');
    }
    return { profile: saved.profile, source: 'persisted', expectedBoundary: saved.effectiveBoundary };
  }
  if (environment !== undefined) {
    return { profile: environment, source: 'environment' };
  }
  return { profile: resolveExecutionProfile(input.defaultProfile).name, source: 'default' };
}

/** Recheck the actual command decision before a resumed session may execute. */
export function assertExecutionBoundary(choice: ExecutionPolicyChoice, decision: GovernedIsolationDecision): void {
  if (decision.kind === 'fail_closed') throw new Error('The selected execution boundary is unavailable.');
  const requiresDocker = resolveExecutionProfile(choice.profile).dockerSandbox === true;
  if ((decision.kind === 'docker' || decision.kind === 'host_escalated') !== requiresDocker) {
    throw new Error('Execution profile and effective boundary do not match.');
  }
  if (decision.kind !== 'docker' && decision.profile !== choice.profile) {
    throw new Error('Execution profile and effective boundary do not match.');
  }
  const boundary: ExecutionBoundary = decision.kind === 'docker' ? 'docker' : 'host';
  if (choice.expectedBoundary && choice.expectedBoundary !== boundary) {
    throw new Error('The effective execution boundary differs from the saved session policy. Select an explicit execution profile to change it.');
  }
}

const activePolicy = new AsyncLocalStorage<Readonly<ExecutionPolicyChoice>>();
export function getActiveExecutionPolicyChoice(): Readonly<ExecutionPolicyChoice> | undefined { return activePolicy.getStore(); }

/** Pin a selection for the complete async lifetime of one admitted session turn. */
export function withExecutionPolicyChoice<T>(choice: ExecutionPolicyChoice, run: () => T): T {
  if (resolveExecutionProfile(choice.profile).name !== choice.profile) throw new Error('Invalid execution policy profile.');
  return activePolicy.run(Object.freeze({ ...choice }), run);
}

/** Use the admitted session profile while still rejecting invalid ambient input. */
export function getScopedExecutionProfile(configured: string | null | undefined): ExecutionProfileName {
  if (configured !== null && configured !== undefined) resolveExecutionProfile(configured);
  return activePolicy.getStore()?.profile ?? resolveExecutionProfile(configured).name;
}

/** Preserve the policy on every asynchronous generator step and its descendants. */
export function scopeExecutionPolicyGenerator<T>(choice: ExecutionPolicyChoice, source: AsyncGenerator<T, void, undefined>): AsyncGenerator<T, void, undefined> {
  const wrapper = {
    [Symbol.asyncIterator]() { return wrapper; },
    next: () => withExecutionPolicyChoice(choice, () => source.next()),
    return: (value?: void) => withExecutionPolicyChoice(choice, () => source.return(value as void)),
    throw: (error: unknown) => withExecutionPolicyChoice(choice, () => source.throw(error)),
  };
  return wrapper as AsyncGenerator<T, void, undefined>;
}

/** Guard process-global profile settings at the actual isolation-decision seam. */
export function assertScopedExecutionPolicy(profile: ExecutionProfileName, decision?: GovernedIsolationDecision): void {
  const choice = activePolicy.getStore();
  if (!choice) return;
  if (choice.profile !== profile) throw new Error('Execution profile differs from the admitted session policy.');
  if (decision && decision.kind !== 'fail_closed') assertExecutionBoundary(choice, decision);
}

const POLICY_FILENAME = 'execution-policy.json';
const MAX_POLICY_BYTES = 4_096;

/** Missing and malformed records are distinct: callers must not guess a legacy boundary. */
export function loadExecutionPolicyRecord(sessionDir: string): PersistedExecutionPolicy | null {
  const path = join(sessionDir, POLICY_FILENAME);
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Invalid persisted execution policy.');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_POLICY_BYTES) {
    throw new Error('Invalid persisted execution policy.');
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_POLICY_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (length > MAX_POLICY_BYTES || length !== after.size || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || !current.isFile() || current.isSymbolicLink() ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new Error();
    return readPersistedPolicy(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } catch {
    throw new Error('Invalid persisted execution policy.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Publish an effective policy after boundary validation. Callers own the
 * session's exclusive writer fence, especially when explicitly migrating.
 */
export function persistExecutionPolicyRecord(
  sessionDir: string,
  choice: ExecutionPolicyChoice,
  decision: GovernedIsolationDecision,
): PersistedExecutionPolicy {
  if (choice.source === 'persisted') throw new Error('A persisted policy cannot be rewritten without an explicit migration.');
  assertExecutionBoundary(choice, decision);
  return writePolicyRecord(sessionDir, choice, decision.kind === 'docker' ? 'docker' : 'host');
}

/**
 * Publish the boundary a profile *requires* when that runtime is not currently
 * available. This records a fail-closed requirement, never an availability
 * claim: every later command still re-evaluates the boundary. Callers own the
 * session's exclusive writer fence.
 */
export function persistRequiredExecutionPolicyRecord(
  sessionDir: string,
  choice: ExecutionPolicyChoice,
): PersistedExecutionPolicy {
  if (choice.source === 'persisted') throw new Error('A persisted policy cannot be rewritten without an explicit migration.');
  return writePolicyRecord(sessionDir, choice, resolveExecutionProfile(choice.profile).dockerSandbox ? 'docker' : 'host');
}

function writePolicyRecord(
  sessionDir: string,
  choice: ExecutionPolicyChoice,
  effectiveBoundary: ExecutionBoundary,
): PersistedExecutionPolicy {
  if (choice.source === 'persisted') throw new Error('A persisted policy cannot be rewritten without an explicit migration.');
  const record: PersistedExecutionPolicy = {
    version: 1,
    profile: choice.profile,
    source: choice.source,
    effectiveBoundary,
  };
  const destination = join(sessionDir, POLICY_FILENAME);
  const temporary = join(sessionDir, `.execution-policy-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // A new record must never replace a concurrently published policy.
      linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (choice.source !== 'migration') throw new Error('Execution policy already exists; an explicit migration is required.');
      const previous = lstatSync(destination);
      if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('Invalid persisted execution policy.');
      renameSync(temporary, destination);
    }
    return record;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
