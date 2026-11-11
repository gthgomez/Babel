import { chatSessionDir } from '../cli/runsLayout.js';
import { evaluateGovernedIsolation, isHostIsolationEscalationAllowed } from './benchmarkContainer.js';
import { resolveExecutionProfile } from './executionProfiles.js';
import { loadExecutionPolicyRecord, persistExecutionPolicyRecord, persistRequiredExecutionPolicyRecord, resolveExecutionPolicyChoice, type ExecutionPolicyChoice } from './executionPolicySelection.js';

function requireSessionId(sessionId: string): void {
  if (!/^[\w-]{1,120}$/.test(sessionId)) throw new Error('Invalid session identity for execution policy.');
}

/** Read the saved authority before changing any process-global profile. */
export function resolveResumedSessionPolicy(sessionId: string, explicitProfile: string | undefined, env: NodeJS.ProcessEnv = process.env): ExecutionPolicyChoice {
  requireSessionId(sessionId);
  const saved = loadExecutionPolicyRecord(chatSessionDir(sessionId));
  return constrainNewSessionPolicy(resolveExecutionPolicyChoice({
    resume:true,
    persisted:saved,
    ...(explicitProfile !== undefined ? {explicitProfile} : {}),
    ...(env['BABEL_EXECUTION_PROFILE'] !== undefined ? {environmentProfile:env['BABEL_EXECUTION_PROFILE']} : {}),
  }), env);
}

/** Caller must hold the session's exclusive lease and have verified its project. */
export function recordResumedSessionMigration(sessionId: string, choice: ExecutionPolicyChoice, env: NodeJS.ProcessEnv = process.env): void {
  requireSessionId(sessionId);
  if (choice.source !== 'migration') return;
  const decision = evaluateGovernedIsolation(choice.profile, undefined, env);
  if (decision.kind === 'fail_closed') throw new Error('The selected execution boundary is unavailable. Repair its setup before changing this session.');
  persistExecutionPolicyRecord(chatSessionDir(sessionId), choice, decision);
}

/** Freeze the boundary a new engine is allowed to use for its lifetime. */
export function constrainNewSessionPolicy(choice: ExecutionPolicyChoice, env: NodeJS.ProcessEnv = process.env): ExecutionPolicyChoice {
  if (choice.expectedBoundary) return { ...choice };
  const profile = resolveExecutionProfile(choice.profile);
  if (!profile.dockerSandbox) return { ...choice, expectedBoundary: 'host' };
  if (!isHostIsolationEscalationAllowed(env)) return { ...choice, expectedBoundary: 'docker' };
  // Legacy explicit host escalation is a separately granted choice. Resolve
  // it once so a running engine cannot change boundaries as the daemon changes.
  const decision = evaluateGovernedIsolation(profile.name, undefined, env);
  return { ...choice, expectedBoundary: decision.kind === 'host_escalated' ? 'host' : 'docker' };
}

/**
 * Publish the selection's required boundary so a later resume preserves it.
 * When the runtime decision is fail-closed the record states the boundary the
 * profile *requires* (Docker), never that the runtime is available; every
 * command still re-evaluates and fails closed. The caller must own a freshly
 * allocated session identity.
 */
export function recordNewSessionPolicy(engine: {
  getEngineRunId?: () => string;
  getExecutionPolicy?: () => Readonly<ExecutionPolicyChoice> | undefined;
}, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = engine.getEngineRunId?.();
  const choice = engine.getExecutionPolicy?.();
  if (!id || !choice || choice.source === 'persisted') return false;
  requireSessionId(id);
  const decision = evaluateGovernedIsolation(choice.profile, undefined, env);
  if (decision.kind === 'fail_closed') {
    persistRequiredExecutionPolicyRecord(chatSessionDir(id), { ...choice });
    return true;
  }
  persistExecutionPolicyRecord(chatSessionDir(id), { ...choice }, decision);
  return true;
}
