// ─── Workflow Domain Types ──────────────────────────────────────────────────
// Shared types for the DAG workflow engine. All types are serializable
// (no class instances) so workflow definitions can round-trip through JSON.

import type { ChatEngine } from '../agent/chatEngine.js';

// ─── Edge conditions ──────────────────────────────────────────────────────

export type EdgeCondition = 'always' | 'on_success' | 'on_failure';

// ─── Dependency edge ──────────────────────────────────────────────────────

export interface WorkflowEdge {
  /** Source node ID that must complete before the dependent node runs. */
  from: string;
  /**
   * When the dependent node should proceed:
   * - 'always' (default): runs regardless of source outcome.
   * - 'on_success': runs only if the source completed successfully.
   * - 'on_failure': runs only if the source failed (recovery / escalation path).
   */
  condition?: EdgeCondition;
}

// ─── Node definition ──────────────────────────────────────────────────────

export interface WorkflowNodeConfig {
  /** Unique node identifier within the workflow. */
  id: string;
  /** The task description — becomes the ChatEngine prompt for this node. */
  task: string;
  /** Optional model override (e.g. 'qwen3', 'deepseek-v4'). */
  model?: string;
  /** Optional model tier override. */
  modelTier?: string;
  /** How many times to retry on failure before giving up. Default: 0. */
  maxRetries?: number;
  /** Per-node timeout in milliseconds. No timeout if omitted or ≤ 0. */
  timeoutMs?: number;
  /**
   * Nodes that must complete before this node can run.
   * Empty array or omitted = root node (no dependencies).
   */
  dependsOn?: WorkflowEdge[];
}

// ─── Workflow definition ──────────────────────────────────────────────────

export interface WorkflowDefinition {
  /** Workflow identifier for logging and event streams. */
  id: string;
  /** All nodes in the DAG. Must be non-empty. */
  nodes: WorkflowNodeConfig[];
  /** Project root passed to every ChatEngine instance. */
  projectRoot: string;
  /** Optional workspace root for tools that write outside the project root. */
  workspaceRoot?: string;
  /** Optional system context injected into every ChatEngine's system prompt. */
  systemContext?: string;
  /** Max parallel nodes. Default: 3. */
  concurrency?: number;
}

// ─── Per-node result ──────────────────────────────────────────────────────

export interface WorkflowNodeResult {
  nodeId: string;
  status: 'completed' | 'failed' | 'skipped';
  /** The full text answer from the ChatEngine session. */
  answer: string;
  /** Token / cost summary from the ChatEngine session. */
  usage?: { totalCostUSD: number; totalTokens: number };
  /** Error message when status is 'failed'. */
  error?: string;
  /** Reason when status is 'skipped' (upstream condition not met). */
  skipReason?: string;
  /** Sub-agents spawned during this node's execution. */
  subAgents?: Array<{
    id: string;
    label: string;
    model?: string;
    summary?: string;
    tokens?: number;
  }>;
  startedAt: Date;
  completedAt: Date;
  /** How many retry attempts were consumed. 0 = first attempt succeeded. */
  retriesConsumed: number;
}

// ─── Workflow-level result ────────────────────────────────────────────────

export interface WorkflowResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'partial';
  nodeResults: WorkflowNodeResult[];
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

// ─── Streaming events ─────────────────────────────────────────────────────
// Yielded by WorkflowEngine.run() for live progress display.

export type WorkflowEvent =
  | {
      type: 'workflow_start';
      workflowId: string;
      totalNodes: number;
    }
  | {
      type: 'node_start';
      nodeId: string;
      task: string;
    }
  | {
      type: 'node_retry';
      nodeId: string;
      attempt: number;
      maxRetries: number;
      error: string;
    }
  | {
      type: 'node_complete';
      nodeId: string;
      answer: string;
      usage?: WorkflowNodeResult['usage'];
    }
  | {
      type: 'node_failed';
      nodeId: string;
      error: string;
      retriesExhausted: boolean;
    }
  | {
      type: 'node_file_changed';
      nodeId: string;
      path: string;
      additions: number;
      deletions: number;
    }
  | {
      type: 'node_skipped';
      nodeId: string;
      reason: string;
    }
  | {
      type: 'workflow_complete';
      workflowId: string;
      status: WorkflowResult['status'];
      nodeResults: WorkflowNodeResult[];
    };

// ─── ChatEngine factory (decouples engine from construction) ──────────────

/**
 * Factory function that creates a ChatEngine for a given workflow node.
 * The workflow engine calls this once per node execution (including retries).
 *
 * Injected by the caller — the REPL handler binds project root and model;
 * tests inject mock engines.
 */
export type ChatEngineFactory = (config: {
  node: WorkflowNodeConfig;
  projectRoot: string;
  workspaceRoot?: string;
  systemContext?: string;
}) => ChatEngine;
