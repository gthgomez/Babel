/**
 * Fix discovery loop — read-only repo exploration before scoped mutation (Phase 2).
 *
 * Phase A: bounded read-only tools via runReadOnlyAgentLoop
 * Phase B/C: delegated to runSmallFixPath after scope resolution
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { EvidenceBundle } from '../../evidence.js';
import type { SmallFixOptions } from '../../services/smallFix.js';
import type { SmallFixScope } from '../../services/fixScopeResolver.js';
import {
  buildReadOnlyToolContext,
  runReadOnlyAgentLoop,
  type ReadOnlyAgentLoopResult,
} from './readOnlyAgentLoop.js';

export interface FixDiscoveryBundle {
  scope: SmallFixScope;
  discovery: ReadOnlyAgentLoopResult;
  discoveryRunDir: string;
}

export function shouldAttemptFixDiscovery(
  options: Pick<SmallFixOptions, 'forcedTargetFile' | 'projectRoot' | 'task'>,
): boolean {
  if (options.forcedTargetFile) {
    return false;
  }
  if (!options.projectRoot) {
    return false;
  }
  return /\b(fix|repair|patch|implement|update|edit|change|correct|resolve)\b/i.test(options.task);
}

export async function runFixDiscoveryPhase(
  options: SmallFixOptions,
  resolveScope: (discovery: ReadOnlyAgentLoopResult) => SmallFixScope | null,
  evidence?: EvidenceBundle,
): Promise<FixDiscoveryBundle | null> {
  if (!options.projectRoot || !shouldAttemptFixDiscovery(options)) {
    return null;
  }

  const projectRoot = options.projectRoot;
  const discoveryRunDir =
    evidence?.runDir ?? join(projectRoot, 'runs', 'babel-lite', `fix-discovery-${Date.now()}`);
  if (!evidence) {
    mkdirSync(discoveryRunDir, { recursive: true });
  }

  const toolContext = buildReadOnlyToolContext({
    verb: 'fix',
    runId: evidence?.runId ?? 'fix-discovery',
    runDir: discoveryRunDir,
  });

  const discovery = await runReadOnlyAgentLoop({
    verb: 'fix',
    task: options.task,
    projectRoot,
    toolContext,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(options.provider === 'mock' || options.provider === 'live'
      ? { provider: options.provider }
      : {}),
    preset: 'read_only',
    maxRounds: 4,
    ...(options.toolStream !== undefined ? { toolStream: options.toolStream } : {}),
  });

  const scope = resolveScope(discovery);

  if (!scope) {
    return null;
  }

  if (evidence) {
    evidence.writeDebugFile(
      'fix_session_loop.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          degraded: discovery.degraded,
          steps: discovery.sessionLoopSteps,
          tool_call_log: discovery.toolCallLog,
          resolved_scope: scope,
        },
        null,
        2,
      )}\n`,
    );
  }

  return {
    scope,
    discovery,
    discoveryRunDir,
  };
}
