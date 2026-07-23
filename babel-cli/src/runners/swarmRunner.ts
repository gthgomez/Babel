import { OrchestratorManifest, SubTask } from '../schemas/agentContracts.js';
import { _runBabelPipelineInternal, PipelineOptions, PipelineResult } from '../pipeline.js';
import { EvidenceBundle } from '../evidence.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface SwarmResult {
  status: 'COMPLETE' | 'FAILED' | 'PARTIAL';
  sub_results: { sub_task_id: string; result: PipelineResult }[];
}

function stringifyErrorValue(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.length > 0) {
      return `${error.name}: ${error.message}`;
    }
    return error.name;
  }
  return String(error);
}

function readSwarmConcurrency(total: number): number {
  const raw = process.env['BABEL_SWARM_CONCURRENCY']?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 3;
  const fallback = Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  return Math.max(1, Math.min(total, fallback));
}

/**
 * Execute async worker functions over an array with a concurrency limit.
 *
 * Results are returned in input order — the result at index `i` corresponds
 * to the item at index `i` in the input array. Callers that pair results
 * back to input items by index rely on this ordering contract.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { status: 'fulfilled', value: await worker(item, index) };
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}

/**
 * Executes a swarm of agents in parallel.
 * Each agent runs in its own sub-run directory within the parent run directory.
 */
export async function runSwarmPipeline(
  manifest: OrchestratorManifest,
  parentEvidence: EvidenceBundle,
  options: PipelineOptions,
): Promise<SwarmResult> {
  if (!manifest.swarm || manifest.swarm.sub_tasks.length === 0) {
    throw new Error('SwarmManifest is missing or empty.');
  }

  const subTasks = manifest.swarm.sub_tasks;
  const concurrency = readSwarmConcurrency(subTasks.length);
  console.log(`[SWARM] Launching ${subTasks.length} agents with concurrency ${concurrency}...`);

  // Fail-fast: AbortController signals remaining workers to bail out when
  // the first failure is detected, preventing further writes.
  const controller = new AbortController();
  let failureDetected = false;

  const results = await runWithConcurrency(subTasks, concurrency, async (subTask, index) => {
    if (controller.signal.aborted) {
      throw new Error(`[SWARM] Sub-task ${subTask.sub_task_id} aborted — prior failure detected.`);
    }
    return runSubTaskAgent(subTask, manifest, parentEvidence, options);
  });

  const subResults: { sub_task_id: string; result: PipelineResult }[] = [];
  let successCount = 0;

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const subTask = subTasks[i];
    if (!res || !subTask) continue;

    const subTaskId = subTask.sub_task_id;
    const subRunDir = join(parentEvidence.runDir, 'swarm', subTaskId);

    if (res.status === 'fulfilled') {
      const pipelineResult = res.value;
      subResults.push({ sub_task_id: subTaskId, result: pipelineResult });
      if (pipelineResult.status === 'COMPLETE') successCount++;
    } else {
      const errorReason = String(res.reason);
      // Signal remaining workers to abort on first failure (fail-fast).
      if (!failureDetected) {
        failureDetected = true;
        controller.abort();
      }
      const fallbackManifest: OrchestratorManifest = {
        ...manifest,
        instruction_stack: subTask.instruction_stack,
        handoff_payload: subTask.handoff_payload,
        swarm: undefined,
      };
      console.error(`[SWARM] Agent ${subTaskId} failed with error:`, errorReason);
      subResults.push({
        sub_task_id: subTaskId,
        result: {
          status: 'FATAL_ERROR',
          runDir: subRunDir,
          manifest: fallbackManifest,
          plan: null,
          errors: [errorReason],
        },
      });
    }
  }

  // Clean up sub-run directories for failed/rejected tasks.
  for (const subResult of subResults) {
    if (subResult.result.status === 'FATAL_ERROR') {
      try {
        rmSync(subResult.result.runDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — don't block the parent result.
      }
    }
  }

  const status =
    successCount === subTasks.length ? 'COMPLETE' : successCount === 0 ? 'FAILED' : 'PARTIAL';

  return {
    status,
    sub_results: subResults,
  };
}

async function runSubTaskAgent(
  subTask: SubTask,
  parentManifest: OrchestratorManifest,
  parentEvidence: EvidenceBundle,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const subRunDir = join(parentEvidence.runDir, 'swarm', subTask.sub_task_id);
  mkdirSync(subRunDir, { recursive: true });
  const subEvidence = EvidenceBundle.fromExistingRun(subRunDir);

  // Create a specialized manifest for this sub-task
  const subManifest: OrchestratorManifest = {
    ...parentManifest,
    instruction_stack: subTask.instruction_stack,
    handoff_payload: subTask.handoff_payload,
    // Clear swarm field to prevent recursive swarming (unless we want deep swarms later)
    swarm: undefined,
  };

  // Update options for the sub-task
  const subOptions: PipelineOptions = {
    ...options,
    mode: 'deep',
    sessionId: `${parentManifest.session_id ?? 'swarm'}_${subTask.sub_task_id}`,
    writeLatestPointers: false,
  };

  try {
    return await _runBabelPipelineInternal(
      subTask.handoff_payload.user_request,
      subOptions,
      subEvidence,
      subManifest,
    );
  } catch (error: unknown) {
    return {
      status: 'FATAL_ERROR',
      runDir: subRunDir,
      manifest: subManifest,
      plan: null,
      errors: [stringifyErrorValue(error)],
    };
  }
}
