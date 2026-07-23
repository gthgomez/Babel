// ─── Types ────────────────────────────────────────────────────────────────────
// Extracted from interactive.ts — types, constants, and configuration data
// used by BabelRepl and extracted command/execution modules.

import type { ValidMode } from '../cli/constants.js';
import type { ModelPolicyModelEntry } from '../modelPolicy.js';
import type { LiteSessionVerb } from '../agent/contracts.js';

export interface SessionState {
  mode: ValidMode;
  project?: string;
  model?: string;
  resolvedModelId?: string;
  approximateCostPerRunUsd?: number;
  router: 'v9';
  compactMode?: 'on' | 'off';
  thinkingCollapsed?: boolean;
  lastRunUserStatus?: 'ready' | 'complete' | 'blocked' | 'failed' | 'cancelled' | 'budget_exhausted';
  lastRunTargetRoot?: string | null;
  projectRoot?: string;
  lastTask?: string;
  lastAnswer?: string | null;
  lastRunDir?: string | null;
  /**
   * Implementor W1.4: operator policy for chat implement path
   * (default | hard_plan | accept_edits | yolo | dry_run).
   */
  operatorMode?: string;
  /** Staged plan body for /execute-plan handoff (hard-plan → implement). */
  pendingPlanBody?: string;
  costTotals: {
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  };
  turnCount: number;
  timestamp?: string;
}

export interface InteractiveTurn {
  schema_version: 1;
  turn_id: number;
  ts: string;
  role: 'user' | 'assistant';
  input?: string;
  resolved_task?: string;
  answer?: string;
  summary?: string;
  run_dir?: string | null;
  target_root?: string | null;
  workspace_root?: string | null;
  changed_files?: string[];
  verification?: string | null;
  next?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MODE_DESCRIPTIONS: Record<string, string> = {
  chat: 'Conversational agent — ask questions, explore code, get answers with live tool visibility.',
  'chat-headless': 'Headless conversational agent — same as chat with JSON output, no TUI.',
  plan: 'Plan-only — shows a detailed plan, waits for approval before any changes.',
  deep: 'Full governed pipeline — planning, review, execution, and verification.',
};

export const MODE_ALIAS_TO_RUNTIME: Record<string, ValidMode> = {
  chat: 'chat',
  'chat-headless': 'chat-headless',
  plan: 'plan',
  deep: 'deep',
};

// ─── Model Aliases ────────────────────────────────────────────────────────────

export const MODEL_ALIASES: Record<
  string,
  (models: { key: string; entry: ModelPolicyModelEntry }[]) => string | null
> = {
  qwen: (_models) => 'qwen3',
  deepseek: (_models) => 'deepseek-v4-pro',
  fast: (models) => {
    const sorted = [...models].sort(
      (a, b) =>
        (a.entry.estimated_cost_per_1m_output ?? Infinity) -
        (b.entry.estimated_cost_per_1m_output ?? Infinity),
    );
    return sorted[0]?.key ?? null;
  },
  smart: (models) => {
    const sorted = [...models].sort(
      (a, b) =>
        (b.entry.estimated_cost_per_1m_output ?? 0) - (a.entry.estimated_cost_per_1m_output ?? 0),
    );
    return sorted[0]?.key ?? null;
  },
};

export const STAGE_LABELS = ['Orchestrator', 'SWE Agent', 'QA Reviewer', 'Executor'];

export const INTERACTIVE_COMMAND_GROUPS = [
  {
    title: 'Daily',
    commands: [
      ['/doctor', 'Run workspace health checks'],
      ['/status', 'Show current session state'],
      ['/permissions [profile]', 'Show or set approval profile'],
      ['/mode [name]', 'List or switch mode — chat (default), chat-headless (CI/headless), plan (ask-first), deep (governed)'],
      ['/execute-plan', 'Stage plan → implement handoff (after hard-plan)'],
      ['/why-stopped', 'Explain last run terminal (phase-gate / policy)'],
      ['/model [key]', 'List models, or set active model'],
      ['/project [name]', 'Set project context or clear it'],
      ['/target', 'Show current target root'],
      ['/retarget [path]', 'Override target root for this session'],
      ['/theme', 'Open the theme picker'],
      ['/keymap', 'Rebind keyboard shortcuts'],
    ],
  },
  {
    title: 'Inspection',
    commands: [
      ['/runs', 'List recent run directories'],
      ['/inspect', 'Inspect the latest run bundle'],
      ['/stats', 'Show performance and usage stats'],
      ['/tools', 'List local tool surfaces'],
      ['/policy', 'Show active model policy'],
      ['/memory', 'Show Chronicle memory surfaces'],
    ],
  },
  {
    title: 'Recovery',
    commands: [
      ['/continue [run]', 'Resume linked worker chain or show continue assessment'],
      ['/chain [run]', 'Show worker_chain_manifest.json status'],
      ['/checkpoint', 'List, inspect, or restore run checkpoints'],
      ['/restore <id>', 'Restore a checkpoint by id'],
      ['/resume [id]', 'List chat sessions or resume a persisted conversation'],
      ['/fork [cell_id]', 'Fork session at checkpoint into a new thread branch'],
      ['/rewind <cell_id>', 'Rewind session to a prior checkpoint'],
      ['/session', 'Show resume context for a run'],
    ],
  },
  {
    title: 'Integrations',
    commands: [
      ['/mcp', 'List configured MCP servers'],
      ['/plugins', 'List runtime plugins and diagnostics'],
      ['/plugin <id> <cmd>', 'Run plugin custom command'],
      ['/agents', 'List, run, inspect, or merge agent team specs'],
    ],
  },
  {
    title: 'Git',
    commands: [
      ['/git status', 'Show working tree status'],
      ['/git diff', 'Show unstaged changes'],
      ['/git log', 'Show recent commit history'],
      ['/ship', 'Implementor ship dry-run (secret scan + evidence PR body); /ship apply'],
      ['/evidence [open|export]', 'Open or export last-run implementor evidence'],
    ],
  },
  {
    title: 'Session',
    commands: [
      ['/workflow <file>', 'Run a multi-node DAG workflow from a JSON definition'],
      ['/dashboard', 'Show session dashboard and live stats'],
      ['/header', 'Show the session header banner'],
      ['/scrollback', 'Browse scrollback history (pager)'],
      ['/cost', 'Show session financial summary'],
      ['/history', 'Show persistent command history'],
      ['/chat', 'Show this session transcript'],
      ['/copy', 'Copy the latest completed output'],
      ['/verbose', 'Toggle verbose log output'],
      ['/compact [on|off]', 'Toggle conversational vs waterfall renderer'],
      ['/notifications [on|off]', 'Toggle desktop notifications for task completion'],
      ['/clear', 'Clear the terminal'],
      ['/exit', 'End session'],
      ['/palette', 'Open command palette (Ctrl+P)'],
    ],
  },
] as const;

export const INTERACTIVE_COMMAND_COMPLETIONS = [
  ...INTERACTIVE_COMMAND_GROUPS.flatMap((group) =>
    group.commands.map(([command]) => command.split(' ')[0] ?? command),
  ),
  '/h',
  '/help',
  '/m',
  '/p',
  '/q',
  '/quit',
  '/settings',
  '/keymap',
] as const;

export const DAILY_COMMAND_VERBS = new Set<LiteSessionVerb>([
  'ask',
  'plan',
  'report',
  'propose',
  'diff',
  'patch',
  'fix',
]);

export const AMBIGUOUS_CONFIRMATION_PATTERN = /^(?:y|yes|ok|okay)$/i;
export const EXPLICIT_FOLLOW_UP_FIX_PATTERN =
  /\b(do that|apply that|make that change|go ahead|continue)\b/i;
export const APPROVAL_READY_STATUSES = new Set(['PROPOSAL_READY', 'PLAN_READY', 'PATCH_READY']);

export interface InteractiveTaskIntentOptions {
  hasPreviousAnswer?: boolean;
  lastStatus?: string | null;
}

export const EXPLICIT_GOVERNED_PATTERN =
  /\b(full\s+lane|full\s+pipeline|governed|verified\s+mode|autonomous\s+mode|babel\s+run)\b/i;
export const PLANNING_INTENT_PATTERN =
  /\b(plan|design|approach|compare|outline|implementation path|migration plan)\b/i;
export const DIRECT_MUTATION_PATTERN =
  /^\s*(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove)\b/i;

export interface InteractiveDailyCommand {
  prefix: 'bl' | 'babel';
  verb: LiteSessionVerb | 'deep';
  task: string;
}

// ─── Model Alias Resolution ──────────────────────────────────────────────────

import { getAvailableModels } from '../modelPolicy.js';

export function resolveModelAlias(
  requested: string,
): { resolvedKey: string; aliasName: string } | null {
  const resolver = MODEL_ALIASES[requested];
  if (!resolver) return null;

  try {
    const available = getAvailableModels();
    const resolvedKey = resolver(available);
    if (!resolvedKey) return null;
    return { resolvedKey, aliasName: requested };
  } catch {
    return null;
  }
}

export function describeVisibleMode(mode: ValidMode): string {
  const normalized = MODE_ALIAS_TO_RUNTIME[mode] ?? mode;
  return normalized;
}
