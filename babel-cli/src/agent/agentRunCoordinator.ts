/**
 * AgentRunCoordinator — sub-agent orchestration hub.
 *
 * Spawns independent ChatEngine instances per sub-agent, each with its own
 * conversation history, model runner, and abort controller. Provides
 * barrier synchronization (awaitAll), selective cancellation, and
 * inter-agent message relay.
 *
 * Phase 0 — foundational class. Phase 1 wires it into chatEngine.ts.
 */

import { ChatEngine, type ChatResult } from './chatEngine.js';
import type { ChatMessage } from './chatCompaction.js';
import { ModelRouter, type ModelRoute } from './modelRouter.js';
import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';
import { allocateThreadId } from '../services/threadStore/threadIds.js';
import { isSuccessfulDirectMutation } from './mutationTools.js';
import { runImplementWorktreeAgent } from './implementWorktreeAgent.js';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentRunSpec {
  /** Unique identifier for this agent (used in logs, TUI, results). */
  id: string;
  /** The task the agent should perform. */
  task: string;
  /** Optional custom system prompt fragment injected after the base prompt. */
  instructions?: string;
  /** Model backend key (e.g. "deepseek-v4-pro", "scout"). */
  model?: string;
  /** Maximum conversation turns (default: from ChatEngineLimits). */
  maxRounds?: number;
  /** When true, the agent gets write access via write_scope. */
  mutation?: boolean;
  /** Paths the mutation agent is allowed to write to. */
  writeScope?: string[];
}

export interface AgentRunResult {
  agentId: string;
  success: boolean;
  summary: string;
  /** Number of tool-call steps executed. */
  steps: number;
  /** The agent's full conversation transcript. */
  conversation: ChatMessage[];
  /** Files changed by this agent (from tool call log). */
  changedFiles: string[];
  /** The model route used for this agent. */
  model: { provider: string; modelId: string };
  /** Raw ChatResult from the engine. */
  raw: ChatResult;
}

export interface AgentRunCoordinatorOptions {
  projectRoot: string;
  /** When provided, cancelling the parent aborts all child agents. */
  parentAbortSignal?: AbortSignal;
  /** Root directory for agent run artifacts. */
  runDir?: string;
  /** Pre-built model router. Created lazily when omitted. */
  modelRouter?: ModelRouter;
}

// ─── AgentRunCoordinator ────────────────────────────────────────────────────

export class AgentRunCoordinator {
  private readonly projectRoot: string;
  private readonly parentAbortSignal: AbortSignal | undefined;
  private readonly runDir: string;
  private readonly modelRouter: ModelRouter;
  private readonly childControllers = new Map<string, AbortController>();
  private readonly results = new Map<string, AgentRunResult>();
  private readonly engines = new Map<string, ChatEngine>();

  constructor(options: AgentRunCoordinatorOptions) {
    this.projectRoot = options.projectRoot;
    this.parentAbortSignal = options.parentAbortSignal;
    this.runDir = options.runDir ?? join(options.projectRoot, '.babel', 'runs', 'agents');
    this.modelRouter = options.modelRouter ?? new ModelRouter();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Spawn a sub-agent with its own ChatEngine instance.
   *
   * Each agent gets an independent conversation history and model runner.
   * The parent's abort signal cascades to children (cancel parent → cancel all).
   * Sibling agents are independent (cancel one → others continue).
   */
  async spawn(spec: AgentRunSpec): Promise<AgentRunResult> {
    const taskLabel = `Agent ${spec.id}: ${spec.task.slice(0, 60)}`;
    const taskId = backgroundTaskRegistry.register(taskLabel);

    // Fork abort controller — linked to parent, independent of siblings
    const childController = new AbortController();
    this.childControllers.set(spec.id, childController);

    const onParentAbort = () => childController.abort();
    this.parentAbortSignal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      // Resolve model route
      const route = this.modelRouter.resolve(spec.model);

      // W2.1: mutation + write_scope → implement worktree isolation (parent stays clean)
      if (
        spec.mutation === true &&
        Array.isArray(spec.writeScope) &&
        spec.writeScope.length > 0 &&
        process.env['BABEL_IMPLEMENT_WORKTREE'] !== '0'
      ) {
        const impl = await runImplementWorktreeAgent(
          {
            id: spec.id,
            task: spec.task,
            writeScope: spec.writeScope,
            ...(spec.maxRounds !== undefined ? { maxRounds: spec.maxRounds } : {}),
            ...(spec.model ? { model: route.modelId } : {}),
          },
          {
            projectRoot: this.projectRoot,
            runDir: join(this.runDir, spec.id),
            abortSignal: childController.signal,
            cleanupWorktree: false,
          },
        );
        const result: AgentRunResult = {
          agentId: spec.id,
          success: impl.success,
          summary: impl.summary,
          steps: impl.stepsExecuted,
          conversation: [],
          changedFiles: impl.changedFiles.map((f) => f.path),
          model: { provider: route.provider, modelId: route.modelId },
          raw: {
            status: impl.success ? 'completed' : 'failed',
            outcome: impl.success ? 'UNVERIFIED_PATCH' : 'AGENT_FAILURE',
            answer: impl.summary,
            usage: {} as ChatResult['usage'],
            conversation: [],
          },
        };
        this.results.set(spec.id, result);
        if (impl.success) {
          backgroundTaskRegistry.complete(taskId);
        } else {
          backgroundTaskRegistry.fail(taskId, impl.error ?? 'implement worktree failed');
        }
        return result;
      }

      // Build engine options
      const engineRunDir = join(this.runDir, spec.id, allocateThreadId());

      const engine = new ChatEngine({
        task: spec.task,
        projectRoot: this.projectRoot,
        ...(spec.instructions ? { appendSystemPrompt: spec.instructions } : {}),
        ...(spec.maxRounds !== undefined ? { maxTurns: spec.maxRounds } : {}),
        // Pass model through to route resolution
        model: route.modelId,
      });

      this.engines.set(spec.id, engine);

      // Execute
      const raw = await engine.submitMessage(spec.task, {});

      // Build result
      const changedFiles = this.extractChangedFiles(raw);
      const result: AgentRunResult = {
        agentId: spec.id,
        success: raw.status === 'completed',
        summary: raw.answer,
        steps: raw.toolCalls?.length ?? 0,
        conversation: raw.conversation,
        changedFiles,
        model: { provider: route.provider, modelId: route.modelId },
        raw,
      };

      this.results.set(spec.id, result);
      backgroundTaskRegistry.complete(taskId);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      backgroundTaskRegistry.fail(taskId, errorMsg);

      const failResult: AgentRunResult = {
        agentId: spec.id,
        success: false,
        summary: `Error: ${errorMsg}`,
        steps: 0,
        conversation: [],
        changedFiles: [],
        model: { provider: 'unknown', modelId: spec.model ?? 'default' },
        raw: { status: 'failed', outcome: 'AGENT_FAILURE', answer: errorMsg, usage: {} as any, conversation: [] },
      };

      this.results.set(spec.id, failResult);
      return failResult;
    } finally {
      this.parentAbortSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * Await all spawned agents to complete.
   * For agents spawned with `spawn()` (which is synchronous per agent),
   * this is a no-op that just returns collected results. In future phases
   * when spawn() runs agents concurrently, this will be the barrier.
   */
  async awaitAll(): Promise<Map<string, AgentRunResult>> {
    return new Map(this.results);
  }

  /** Cancel a specific agent by ID without affecting siblings. */
  cancel(agentId: string): void {
    const controller = this.childControllers.get(agentId);
    if (controller) {
      controller.abort();
      this.childControllers.delete(agentId);
    }
    const engine = this.engines.get(agentId);
    if (engine) {
      engine.cancel();
      this.engines.delete(agentId);
    }
  }

  /** Cancel all running agents. */
  cancelAll(): void {
    for (const [id] of this.childControllers) {
      this.cancel(id);
    }
  }

  /** Get the result for a specific agent (undefined if not yet complete). */
  getResult(agentId: string): AgentRunResult | undefined {
    return this.results.get(agentId);
  }

  /** Get all results collected so far. */
  getAllResults(): Map<string, AgentRunResult> {
    return new Map(this.results);
  }

  /** The underlying model router (useful for pre-warming). */
  getModelRouter(): ModelRouter {
    return this.modelRouter;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private extractChangedFiles(result: ChatResult): string[] {
    if (!result.toolCalls) return [];
    return result.toolCalls
      .filter((tc) => isSuccessfulDirectMutation(tc.tool, tc.error))
      .map((tc) => tc.target)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
}
