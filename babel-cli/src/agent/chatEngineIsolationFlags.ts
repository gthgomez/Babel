/**
 * H4 isolation + dirty-tree flags for ChatEngine → capability broker.
 *
 * ChatExecutionProfile ('chat'|'plan'|'deep') is a controller mode — NOT an
 * ExecutionProfileName. Passing it into evaluateGovernedIsolation resolved to
 * DEFAULT safe_repo and CAPABILITY_DENIED every tool when Docker was absent.
 * Isolation profile comes from BABEL_EXECUTION_PROFILE (same as sandbox.ts).
 */

import { evaluateGovernedIsolation } from '../config/benchmarkContainer.js';
import { detectWorkingTreeDirty } from './capabilityBroker.js';
import { getExecutionContext } from './executionContext.js';

export interface IsolationBrokerFlags {
  isolationRequired: boolean;
  isolationAvailable: boolean;
  hostFallbackAllowed: boolean;
  dirtyTree: boolean;
}

/**
 * Resolve capability-broker isolation flags for a ChatEngine project root.
 * Dirty-tree fail-closed applies when isolation is required or
 * BABEL_REQUIRE_CLEAN_TREE=1 (everyday host_profile may still mutate dirty).
 */
export function resolveIsolationBrokerFlags(projectRoot: string): IsolationBrokerFlags {
  const d = evaluateGovernedIsolation(
    process.env['BABEL_EXECUTION_PROFILE'],
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] ?? null,
  );
  const isolationRequired =
    d.kind === 'fail_closed' || d.kind === 'docker' || d.kind === 'host_escalated';
  const isolationAvailable = d.kind === 'docker';
  const hostFallbackAllowed = d.kind === 'host_escalated' || d.kind === 'host_profile';
  const enforceClean =
    process.env['BABEL_REQUIRE_CLEAN_TREE'] === '1' || isolationRequired;
  const gitDirty = enforceClean && detectWorkingTreeDirty(projectRoot);
  const ownership = getExecutionContext()?.mutationOwnership;
  const changes = gitDirty && ownership?.matchesRoot(projectRoot)
    ? ownership.classifyChanges() : null;
  const unexpectedDirty = changes
    ? changes.unexpectedPaths.length > 0 || changes.unverifiablePaths.length > 0
    : gitDirty;
  const dirtyTree =
    process.env['BABEL_DIRTY_TREE'] === '1'
      ? true
      : process.env['BABEL_DIRTY_TREE'] === '0'
        ? false
        : enforceClean && (process.env['BABEL_REQUIRE_CLEAN_TREE'] === '1' ? gitDirty : unexpectedDirty);
  return {
    isolationRequired,
    isolationAvailable,
    hostFallbackAllowed,
    dirtyTree,
  };
}
