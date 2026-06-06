import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { runBeforeCompleteHooks, type RuntimeHookTraceEvent } from '../runtime/hooks.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { BenchmarkVerificationResult } from './benchmarkVerification.js';
import {
  verifyBoundedTaskArtifacts,
  verifyRequestedOutputArtifacts,
} from './verification.js';

export interface PreCompleteGuardInput {
  rawTask: string;
  toolCallLog: readonly ToolCallLog[];
  projectRoot: string | null;
  exactOutputSchemaFailure?: string | null;
  exactInvariantFailure?: string | null;
}

export interface PreCompleteGuardResult {
  semanticFailure: string | null;
  runtimeHookTraceEvents: RuntimeHookTraceEvent[];
  benchmarkVerification: BenchmarkVerificationResult | null;
}

function isExternalBenchmarkTask(rawTask: string): boolean {
  return /\bTerminal-Bench 2 task\b/i.test(rawTask) ||
    /\bSWE-rebench\b/i.test(rawTask);
}

function taskRequestsRoiResearchNote(rawTask: string): boolean {
  return /\bROI\b/i.test(rawTask) && /\bresearch note\b/i.test(rawTask);
}

function verifyRoiResearchNote(rawTask: string, toolCallLog: readonly ToolCallLog[], projectRoot: string | null): string | null {
  if (!projectRoot || !taskRequestsRoiResearchNote(rawTask)) {
    return null;
  }

  const roiWrite = [...toolCallLog].reverse().find(entry =>
    entry.tool === 'file_write' &&
    entry.exit_code === 0 &&
    /roi/i.test(String(entry.target ?? '')) &&
    /\.(?:md|txt)$/i.test(String(entry.target ?? '')),
  );
  if (!roiWrite) {
    return 'ROI research postcondition failed: no ROI research note file was written.';
  }

  const target = String(roiWrite.target ?? '').trim();
  const relativeTarget = target.replace(/\\/g, '/').startsWith(projectRoot.replace(/\\/g, '/'))
    ? target.slice(projectRoot.length).replace(/^[/\\]+/, '')
    : target;
  const resolvedTarget = resolve(projectRoot, relativeTarget);
  if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) {
    return 'ROI research postcondition failed: the written ROI note is not readable.';
  }

  const content = readFileSync(resolvedTarget, 'utf-8');
  const includesMarketMetrics = /\b(?:ARPDAU|retention|CPI|CPM|downloads?|revenue|LTV|ROAS)\b/i.test(content) ||
    /\$\d/.test(content) ||
    /\b\d+(?:\.\d+)?%\b/.test(content);
  const hasEvidenceQualifier = /\b(?:source|citation|cited|https?:\/\/|unverified|model-prior|model prior|unknown)\b/i.test(content);

  if (includesMarketMetrics && !hasEvidenceQualifier) {
    return 'ROI research postcondition failed: market metrics require citations/sources or an explicit unverified/model-prior label.';
  }

  return null;
}

export function evaluatePreCompleteGuards(input: PreCompleteGuardInput): PreCompleteGuardResult {
  const beforeCompleteHooks = runBeforeCompleteHooks({
    rawTask: input.rawTask,
    toolCallLog: input.toolCallLog,
  });

  const semanticFailure =
    verifyRequestedOutputArtifacts(input.rawTask, input.projectRoot) ??
    verifyRoiResearchNote(input.rawTask, input.toolCallLog, input.projectRoot) ??
    input.exactOutputSchemaFailure ??
    input.exactInvariantFailure ??
    beforeCompleteHooks.message ??
    (isExternalBenchmarkTask(input.rawTask)
      ? null
      : verifyBoundedTaskArtifacts(
        input.rawTask,
        [...input.toolCallLog],
        input.projectRoot,
      ));

  return {
    semanticFailure,
    runtimeHookTraceEvents: beforeCompleteHooks.traces,
    benchmarkVerification: beforeCompleteHooks.benchmarkVerification,
  };
}
