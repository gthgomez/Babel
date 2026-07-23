// ─── DAG Workflow Engine ────────────────────────────────────────────────────
// Executes a WorkflowDefinition by topologically sorting nodes, resolving
// conditional edges, and dispatching independent nodes in parallel via
// runWithConcurrency(). Each node is a separate ChatEngine session.
//
// Architecture:
//   WorkflowEngine.run()          — async generator yielding WorkflowEvents
//     ├─ topologicalSort()        — Kahn's algorithm → parallel levels
//     ├─ resolveConditionalEdges()— filter level by upstream outcomes
//     └─ runWithConcurrency()     — parallel dispatch from swarmRunner.ts

import { runWithConcurrency } from '../runners/swarmRunner.js';
import { withTimeout } from '../agent/toolExecutor.js';
import type {
  ChatEngineFactory,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowNodeConfig,
  WorkflowNodeResult,
} from './workflowNode.js';

// ─── Internal types ───────────────────────────────────────────────────────

/** Returned by executeNodeWithRetry — bundles the result with any
 *  intermediate events (retry notifications) that occurred during execution. */
interface NodeExecutionOutcome {
  result: WorkflowNodeResult;
  events: WorkflowEvent[];
}

// ─── Pure: topological sort (Kahn's algorithm) ────────────────────────────

/**
 * Topologically sort workflow nodes into parallel-executable levels.
 *
 * All dependency edges increase in-degree (including `on_failure` edges —
 * we must wait for the upstream outcome before deciding whether to proceed).
 * The condition itself is evaluated later by `resolveConditionalEdges`.
 *
 * @returns Array of levels, each being an array of node IDs that can run concurrently.
 * @throws If a cycle is detected or a node references a non-existent dependency.
 */
export function topologicalSort(nodes: WorkflowNodeConfig[]): string[][] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const node of nodes) {
    for (const edge of node.dependsOn ?? []) {
      if (!nodeMap.has(edge.from)) {
        throw new Error(
          `Node "${node.id}" depends on unknown node "${edge.from}"`,
        );
      }
      adjacency.get(edge.from)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const levels: string[][] = [];
  const processed = new Set<string>();
  const queue: string[] = [];

  // Seed the queue with all nodes that have no dependencies
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  // Process in BFS layers: nodes at the same depth form a parallel level.
  // Each node and each edge is visited exactly once (O(V + E)).
  while (queue.length > 0) {
    const levelSize = queue.length;
    const currentLevel: string[] = [];

    for (let i = 0; i < levelSize; i++) {
      const nodeId = queue.shift()!;
      currentLevel.push(nodeId);
      processed.add(nodeId);

      for (const dependent of adjacency.get(nodeId) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    levels.push(currentLevel);
  }

  if (processed.size !== nodes.length) {
    const remaining = nodes
      .filter((n) => !processed.has(n.id))
      .map((n) => n.id);
    throw new Error(
      `Cycle detected in workflow DAG. Remaining nodes: ${remaining.join(', ')}`,
    );
  }

  return levels;
}

// ─── Pure: conditional edge resolution ────────────────────────────────────

/**
 * Filter a topological level by evaluating dependency edge conditions
 * against completed upstream results.
 *
 * Routing rules per edge condition:
 * - `always`:     proceeds regardless of upstream outcome.
 * - `on_success`: proceeds only if upstream completed; skipped if failed or skipped.
 * - `on_failure`: proceeds only if upstream failed; skipped if completed or skipped.
 *
 * Transitive skip: if any upstream was skipped and the condition would
 * require its outcome, this node is also skipped.
 */
export function resolveConditionalEdges(
  levelNodes: WorkflowNodeConfig[],
  results: ReadonlyMap<string, WorkflowNodeResult>,
): { proceed: WorkflowNodeConfig[]; skipped: Array<{ node: WorkflowNodeConfig; reason: string }> } {
  const proceed: WorkflowNodeConfig[] = [];
  const skipped: Array<{ node: WorkflowNodeConfig; reason: string }> = [];

  for (const node of levelNodes) {
    let shouldSkip = false;
    let skipReason = '';

    for (const edge of node.dependsOn ?? []) {
      const upstream = results.get(edge.from);
      const condition = edge.condition ?? 'always';

      if (!upstream) {
        shouldSkip = true;
        skipReason = `Upstream node "${edge.from}" has not executed`;
        break;
      }

      if (upstream.status === 'skipped') {
        // A skipped upstream never produced a real outcome.
        // on_failure of a skipped node → node didn't fail, so don't run.
        shouldSkip = true;
        skipReason = `Upstream node "${edge.from}" was skipped (${upstream.skipReason ?? 'condition not met'})`;
        break;
      }

      if (condition === 'on_success' && upstream.status !== 'completed') {
        shouldSkip = true;
        skipReason = `Upstream node "${edge.from}" did not complete successfully (status: ${upstream.status})`;
        break;
      }

      if (condition === 'on_failure' && upstream.status !== 'failed') {
        shouldSkip = true;
        skipReason = `Upstream node "${edge.from}" did not fail (status: ${upstream.status})`;
        break;
      }

      // 'always' condition: proceeds regardless
    }

    if (shouldSkip) {
      skipped.push({ node, reason: skipReason });
    } else {
      proceed.push(node);
    }
  }

  return { proceed, skipped };
}

// ─── WorkflowEngine ───────────────────────────────────────────────────────

export class WorkflowEngine {
  private definition: WorkflowDefinition;
  private factory: ChatEngineFactory;
  private abortController: AbortController;

  constructor(definition: WorkflowDefinition, factory: ChatEngineFactory) {
    if (!definition.nodes || definition.nodes.length === 0) {
      throw new Error('WorkflowDefinition must have at least one node');
    }
    this.definition = definition;
    this.factory = factory;
    this.abortController = new AbortController();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Execute the workflow, yielding events as nodes start, complete, fail,
   * or are skipped. The caller iterates with:
   *
   *   for await (const event of engine.run()) { ... }
   *
   * The generator completes after the final `workflow_complete` event.
   */
  async *run(): AsyncGenerator<WorkflowEvent, void, undefined> {
    const nodeMap = new Map(this.definition.nodes.map((n) => [n.id, n]));

    // Validate: every dependsOn.from must reference an existing node
    for (const node of this.definition.nodes) {
      for (const edge of node.dependsOn ?? []) {
        if (!nodeMap.has(edge.from)) {
          throw new Error(
            `Node "${node.id}" depends on unknown node "${edge.from}"`,
          );
        }
      }
    }

    yield {
      type: 'workflow_start',
      workflowId: this.definition.id,
      totalNodes: this.definition.nodes.length,
    };

    const levels = topologicalSort(this.definition.nodes);
    const results = new Map<string, WorkflowNodeResult>();
    const concurrency = this.definition.concurrency ?? 3;

    for (const level of levels) {
      if (this.abortController.signal.aborted) break;

      const levelNodes = level.map((id) => nodeMap.get(id)!);

      const { proceed, skipped } = resolveConditionalEdges(levelNodes, results);

      // Record and yield skipped nodes
      for (const { node, reason } of skipped) {
        const result: WorkflowNodeResult = {
          nodeId: node.id,
          status: 'skipped',
          answer: '',
          skipReason: reason,
          startedAt: new Date(),
          completedAt: new Date(),
          retriesConsumed: 0,
        };
        results.set(node.id, result);
        yield { type: 'node_skipped', nodeId: node.id, reason };
      }

      if (proceed.length === 0) continue;

      // Yield node_start for all nodes that will execute
      for (const node of proceed) {
        yield { type: 'node_start', nodeId: node.id, task: node.task };
      }

      // Execute proceed nodes in parallel. Each worker handles its own
      // retry loop and returns intermediate events for the main loop to yield.
      const settled = await runWithConcurrency(
        proceed,
        concurrency,
        (node) => this.executeNodeWithRetry(node),
      );

      // Collect results and yield completion events
      // Index `i` is shared across settled and proceed, relying on
      // runWithConcurrency's contract that results are returned in input order.
      for (let i = 0; i < settled.length; i++) {
        const entry = settled[i]!;
        const node = proceed[i]!;

        if (entry.status === 'fulfilled') {
          const { result, events } = entry.value;

          // Yield any retry events that occurred during execution
          for (const event of events) {
            yield event;
          }

          results.set(node.id, result);

          if (result.status === 'completed') {
            yield {
              type: 'node_complete',
              nodeId: result.nodeId,
              answer: result.answer,
              usage: result.usage,
            };
          } else {
            yield {
              type: 'node_failed',
              nodeId: result.nodeId,
              error: result.error ?? 'Unknown error',
              retriesExhausted: true,
            };
          }
        } else {
          // Worker itself threw (shouldn't happen with retry wrapper)
          const errorMsg =
            entry.reason instanceof Error
              ? entry.reason.message
              : String(entry.reason);
          const result: WorkflowNodeResult = {
            nodeId: node.id,
            status: 'failed',
            answer: '',
            error: errorMsg,
            startedAt: new Date(),
            completedAt: new Date(),
            retriesConsumed: 0,
          };
          results.set(node.id, result);
          yield {
            type: 'node_failed',
            nodeId: node.id,
            error: errorMsg,
            retriesExhausted: false,
          };
        }
      }
    }

    const nodeResults = [...results.values()];
    const allSucceeded = nodeResults.every(
      (r) => r.status === 'completed' || r.status === 'skipped',
    );
    const allFailed = nodeResults.every(
      (r) => r.status === 'failed' || r.status === 'skipped',
    );
    const status = allSucceeded
      ? 'completed'
      : allFailed
        ? 'failed'
        : 'partial';

    yield {
      type: 'workflow_complete',
      workflowId: this.definition.id,
      status,
      nodeResults,
    };

  }

  /** Cancel an in-progress workflow. Running nodes finish their current
   *  turn but no new levels are dispatched. */
  cancel(): void {
    this.abortController.abort();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Execute a single node with retry logic.
   *
   * On each attempt, creates a fresh ChatEngine via the factory, calls
   * `submitMessage`, and collects the answer. If the node fails and has
   * retries remaining, re-attempts (up to maxRetries).
   *
   * The factory is called once per attempt so each retry gets a fresh
   * ChatEngine with clean conversation state.
   */
  private async executeNodeWithRetry(
    node: WorkflowNodeConfig,
  ): Promise<NodeExecutionOutcome> {
    const maxRetries = node.maxRetries ?? 0;
    let lastError: string | undefined;
    const events: WorkflowEvent[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.abortController.signal.aborted) {
        return {
          result: {
            nodeId: node.id,
            status: 'failed',
            answer: '',
            error: 'Cancelled',
            startedAt: new Date(),
            completedAt: new Date(),
            retriesConsumed: attempt,
          },
          events,
        };
      }

      if (attempt > 0) {
        events.push({
          type: 'node_retry',
          nodeId: node.id,
          attempt,
          maxRetries,
          error: lastError!,
        });
      }

      try {
        const { result: attemptResult, events: attemptEvents } = await withTimeout(
          this.executeSingleAttempt(node, this.abortController.signal),
          node.timeoutMs ?? 0,
          node.id,
        );
        events.push(...attemptEvents);

        if (attemptResult.status === 'completed') {
          return {
            result: { ...attemptResult, retriesConsumed: attempt },
            events,
          };
        }

        lastError = attemptResult.error;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // All retries exhausted
    return {
      result: {
        nodeId: node.id,
        status: 'failed',
        answer: '',
        error: lastError ?? 'Unknown error',
        startedAt: new Date(),
        completedAt: new Date(),
        retriesConsumed: maxRetries,
      },
      events,
    };
  }

  /**
   * Execute a single ChatEngine session for a node (no retry logic).
   * Creates a fresh engine via the factory, runs the task, and collects
   * the full answer text.
   */
  private async executeSingleAttempt(
    node: WorkflowNodeConfig,
    signal?: AbortSignal,
  ): Promise<{ result: WorkflowNodeResult; events: WorkflowEvent[] }> {
    const startedAt = new Date();
    const events: WorkflowEvent[] = [];

    const engine = this.factory({
      node,
      projectRoot: this.definition.projectRoot,
      ...(this.definition.workspaceRoot !== undefined
        ? { workspaceRoot: this.definition.workspaceRoot }
        : {}),
      ...(this.definition.systemContext !== undefined
        ? { systemContext: this.definition.systemContext }
        : {}),
    });

    // When the abort signal fires (timeout or workflow cancellation),
    // cancel the ChatEngine to stop in-flight API calls.
    const cancelEngine = () => engine.cancel();
    signal?.addEventListener('abort', cancelEngine, { once: true });

    let answer = '';
    const subAgents: NonNullable<WorkflowNodeResult['subAgents']> = [];

    try {
      const result = await engine.submitMessage(node.task, {
        onAnswerChunk: (chunk) => {
          answer += chunk;
        },
        onToolStart: () => -1,
        onThought: () => {},
        onToolComplete: () => {},
        onFileChanged: (path, additions, deletions) => {
          events.push({ type: 'node_file_changed', nodeId: node.id, path, additions, deletions });
        },
        onSubAgentStart: (info) => {
          if (!subAgents.find((s) => s.id === info.id)) {
            const entry: NonNullable<WorkflowNodeResult['subAgents']>[number] = { id: info.id, label: info.label };
            if (info.model !== undefined) entry.model = info.model;
            subAgents.push(entry);
          }
        },
        onSubAgentComplete: (info) => {
          const existing = subAgents.find((s) => s.id === info.id);
          if (existing) {
            if (info.summary !== undefined) existing.summary = info.summary;
            if (info.tokens !== undefined) existing.tokens = info.tokens;
          }
        },
      });

      const completedAt = new Date();

      // Fix 3: for failed nodes, use result.answer (full engine response)
      // rather than the partial chunk-accumulated answer variable
      const baseResult: WorkflowNodeResult = {
        nodeId: node.id,
        status: result.status === 'completed' ? 'completed' : 'failed',
        answer: result.status === 'failed' ? result.answer : answer,
        startedAt,
        completedAt,
        retriesConsumed: 0, // set by caller
      };

      if (result.usage) {
        baseResult.usage = {
          totalCostUSD: result.usage.totalCostUSD,
          totalTokens: result.usage.totalTokens,
        };
      }
      if (result.status === 'failed') {
        baseResult.error = result.answer;
      }
      if (result.status === 'cancelled') {
        baseResult.error = 'Node execution was cancelled';
      }
      if (subAgents.length > 0) {
        baseResult.subAgents = subAgents;
      }

      return { result: baseResult, events };
    } finally {
      signal?.removeEventListener('abort', cancelEngine);
    }
  }
}

