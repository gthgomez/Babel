// ─── Info / Status Command Handlers ──────────────────────────────────────────
// Extracted from interactive.ts — display-oriented commands that show session
// state, run stats, tools, memory, transcripts, and dashboards.
//
// resolveRunDir is exported here because it is used by both info.ts and
// service.ts handlers.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ReplContext } from '../context.js';
import { describeVisibleMode } from '../types.js';
import { getRecentRuns } from '../utils.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { buildRunStats, formatRunStatsHuman } from '../../services/runStats.js';
import { runDoctor, formatDoctorHuman } from '../../doctor.js';
import { BABEL_ROOT } from '../../cli/constants.js';
import { copyFileToClipboard } from '../../cli/helpers.js';
import { copyToClipboardWithFeedback, isClipboardSupported } from '../../ui/clipboard.js';
import { renderChatTranscript } from '../../ui/chatPanel.js';
import { highlightCodeBlocks } from '../../ui/highlight.js';
import { renderErrorPanel, renderOperatorHeader } from '../../ui/renderers.js';
import {
  accentBright,
  muted,
  primary,
  dim,
  bold,
  padRight,
  getTerminalWidth,
} from '../../ui/theme.js';
import { readApprovalProfileStatus } from '../../config/approvalProfiles.js';
import {
  detectEnvBlockedFromText,
  formatWhyStopped,
} from '../../agent/implementorPolicy.js';

// ── Shared helper ────────────────────────────────────────────────────────────

export function resolveRunDir(ctx: ReplContext, arg?: string): string {
  if (!arg || arg.toLowerCase() === 'latest') {
    const latest = ctx.lastRunDir ?? getRecentRuns(1)[0];
    if (!latest) {
      throw new Error('No recent run is available.');
    }
    return latest;
  }
  return path.resolve(arg);
}

// ── Status ───────────────────────────────────────────────────────────────────

export function handleStatus(ctx: ReplContext, _args: string[]): void {
  const permissions = readApprovalProfileStatus();
  console.log(primary('\n  Session State:'));
  console.log(
    `    ${muted(padRight('Mode', 10))} ${accentBright(describeVisibleMode(ctx.state.mode))}`,
  );
  console.log(`    ${muted(padRight('Router', 10))} ${ctx.state.router}`);
  console.log(
    `    ${muted(padRight('Project', 10))} ${ctx.state.project ?? muted('(auto-detect)')}`,
  );
  console.log(
    `    ${muted(padRight('Model', 10))} ${ctx.state.model ? accentBright(ctx.state.model) : muted('(route-selected)')}`,
  );
  console.log(`    ${muted(padRight('Profile', 10))} ${accentBright(permissions.profile)}`);
  if (ctx.state.resolvedModelId) {
    console.log(`    ${muted(padRight('Provider', 10))} ${muted(ctx.state.resolvedModelId)}`);
  }
  if (ctx.state.approximateCostPerRunUsd !== undefined) {
    console.log(
      `    ${muted(padRight('Cost', 10))} ${muted(`$${ctx.state.approximateCostPerRunUsd.toFixed(4)} / run`)}`,
    );
  }
  console.log(
    `    ${muted(padRight('Verbose', 10))} ${ctx.verboseMode ? accentBright('on') : muted('off')}\n`,
  );
}

export async function handleDoctor(_ctx: ReplContext, _args: string[]): Promise<void> {
  try {
    const result = await runDoctor({
      babelRoot: BABEL_ROOT,
      scope: 'workspace' as const,
      strict: false,
      verbose: false,
    });
    console.log('\n' + formatDoctorHuman(result, false));
  } catch (error: any) {
    console.log(
      '\n' +
        renderErrorPanel(
          'Doctor Failed',
          error.message,
          'Check your workspace setup with /doctor --scope env',
        ),
    );
  }
}

export function handleTools(_ctx: ReplContext, _args: string[]): void {
  const tools = [
    'directory_list',
    'file_read',
    'file_write',
    'shell_exec',
    'test_run',
    'mcp_request',
    'mcp_resource_list',
    'mcp_resource_read',
    'mcp_prompt_list',
    'mcp_prompt_get',
    'mcp_tool_search',
    'web_search',
    'web_fetch',
    'audit_ui',
    'memory_store',
    'memory_query',
    'semantic_search',
    'plugin_tool',
  ];
  console.log(primary('\n  Local Tools:'));
  tools.forEach((tool) => console.log(`    ${muted('*')} ${accentBright(tool)}`));
  console.log(muted('\n  Evidence: /doctor  /inspect  /runs'));
}

export function handleMemory(_ctx: ReplContext, _args: string[]): void {
  console.log(primary('\n  Chronicle Memory:'));
  console.log(`    ${muted(padRight('Store', 14))} memory_store`);
  console.log(`    ${muted(padRight('Query', 14))} memory_query`);
  console.log(`    ${muted(padRight('Search', 14))} semantic_search`);
  console.log(
    muted('\n  Memory tools are available to pipeline executors and recorded in run evidence.'),
  );
}

export function handleChat(ctx: ReplContext, _args: string[]): void {
  console.log(
    highlightCodeBlocks(
      renderChatTranscript(ctx.turns, {
        transcriptPath: ctx.interactiveTranscriptPath,
      }),
    ),
  );
}

export function handleLast(ctx: ReplContext, _args: string[]): void {
  if (ctx.lastRunTranscript) {
    console.log(muted('\n  ── Last Run Activity ──\n'));
    console.log(ctx.lastRunTranscript);
  } else {
    console.log(muted('\n  No previous run activity available. Run a task first.'));
  }
}

// ── Copy / Clipboard ─────────────────────────────────────────────────────────

export function handleCopy(ctx: ReplContext, _args: string[]): void {
  // Try OSC 52 clipboard first (works on all platforms with modern terminals)
  if (isClipboardSupported()) {
    let textToCopy: string | null = null;

    // Prefer the human_summary.txt file if available
    if (ctx.lastRunDir) {
      const summaryPath = path.join(ctx.lastRunDir, 'human_summary.txt');
      if (fs.existsSync(summaryPath)) {
        textToCopy = fs.readFileSync(summaryPath, 'utf-8').trim();
      }
    }

    // Fall back to last assistant answer in memory
    if (!textToCopy && ctx.lastAssistantAnswer) {
      textToCopy = ctx.lastAssistantAnswer;
    }

    if (textToCopy) {
      const feedback = copyToClipboardWithFeedback(textToCopy);
      console.log(muted(`\n  ${feedback}`));
      return;
    }
  }

  // Fallback: Windows PowerShell clipboard (for legacy consoles without OSC 52)
  if (ctx.lastRunDir) {
    const summaryPath = path.join(ctx.lastRunDir, 'human_summary.txt');
    if (fs.existsSync(summaryPath)) {
      const copied = copyFileToClipboard(summaryPath);
      if (copied.ok) {
        console.log(muted('\n  Copied latest completed output to clipboard.'));
        return;
      }
      console.log(muted(`\n  Clipboard copy failed: ${copied.warning ?? 'unknown error'}`));
      const summary = fs.readFileSync(summaryPath, 'utf-8').trim();
      if (summary.length > 0) {
        console.log(`\n${summary}\n`);
        return;
      }
    }
  }

  if (!ctx.lastAssistantAnswer) {
    console.log(muted('\n  No assistant answer is available yet.'));
    return;
  }
  console.log(`\n${ctx.lastAssistantAnswer}\n`);
}

// ── Target ───────────────────────────────────────────────────────────────────

export function handleTarget(ctx: ReplContext, _args: string[]): void {
  const target = ctx.resolveCurrentTarget();
  console.log(primary('\n  Target:'));
  console.log(`    ${muted(padRight('Root', 14))} ${accentBright(target.targetRoot)}`);
  console.log(`    ${muted(padRight('Source', 14))} ${target.source}`);
  if (target.workspaceRoot) {
    console.log(`    ${muted(padRight('Workspace', 14))} ${muted(target.workspaceRoot)}`);
  }
  ctx.scheduleIndexWarmup(target.targetRoot);
  console.log(muted('\n  Use /retarget <path> to override, or /retarget to clear the override.'));
}

// ── Why stopped (implementor W1.5) ───────────────────────────────────────────

/**
 * Explain the last run terminal from harness policy events / cards when present.
 * Falls back to session hints when no run dir is available.
 */
export function handleWhyStopped(ctx: ReplContext, args: string[]): void {
  let status = 'unknown';
  let hasAnyWrites = false;
  let envBlocked = false;
  let lastPolicyEvents: Array<{ kind: string; detail?: string; at_turn?: number; tool?: string }> =
    [];
  let topBlockedReason: string | undefined;
  let blockedAttempts: Array<{ reason: string; tool: string }> | undefined;

  try {
    const runDir = resolveRunDir(ctx, args[0]);
    const harnessCandidates = [
      path.join(runDir, 'harness.json'),
      ...fs
        .readdirSync(runDir)
        .filter((f) => f.endsWith('-harness.json'))
        .map((f) => path.join(runDir, f)),
    ];
    for (const hp of harnessCandidates) {
      if (!fs.existsSync(hp)) continue;
      const raw = JSON.parse(fs.readFileSync(hp, 'utf8')) as Record<string, unknown>;
      type CliPayload = {
        status?: unknown;
        answer?: string;
        policy_events?: Array<{ kind: string; detail?: string; at_turn?: number; tool?: string }>;
      };
      const cliPayload = raw['cli_payload'] as CliPayload | undefined;
      status = String(raw['status'] ?? cliPayload?.status ?? 'unknown');
      const patch = raw['patch_reality'] as { empty_patch?: boolean } | undefined;
      if (patch) hasAnyWrites = patch.empty_patch === false;
      const writeCount = raw['write_count'];
      if (typeof writeCount === 'number') hasAnyWrites = writeCount > 0;
      const policy = cliPayload?.policy_events;
      if (Array.isArray(policy)) lastPolicyEvents = policy;
      const blocked = raw['blocked_attempt_counts'] as { byReason?: Record<string, number> } | undefined;
      if (blocked?.byReason) {
        const top = Object.entries(blocked.byReason).sort((a, b) => b[1] - a[1])[0];
        if (top) topBlockedReason = top[0];
      }
      // W1.2: blocked_attempts ledger for phase-gate write-block visibility
      const attempts = raw['blocked_attempts'];
      if (Array.isArray(attempts)) {
        blockedAttempts = attempts as Array<{ reason: string; tool: string }>;
      }
      // Also accept top-level phase-gate counters if present
      const answer = String(cliPayload?.answer ?? '');
      envBlocked = detectEnvBlockedFromText(answer) || status === 'ENV_BLOCKED';
      break;
    }
    const policyPath = path.join(runDir, 'policy-events.jsonl');
    if (lastPolicyEvents.length === 0 && fs.existsSync(policyPath)) {
      lastPolicyEvents = fs
        .readFileSync(policyPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as {
              kind: string;
              detail?: string;
              at_turn?: number;
              tool?: string;
            };
          } catch {
            return null;
          }
        })
        .filter(
          (x): x is { kind: string; detail?: string; at_turn?: number; tool?: string } => x != null,
        );
    }
  } catch {
    status = ctx.lastAssistantAnswer ? 'session_answer' : 'no_run';
    if (ctx.lastAssistantAnswer) {
      envBlocked = detectEnvBlockedFromText(ctx.lastAssistantAnswer);
    }
  }

  console.log(primary('\n  Why stopped:\n'));
  console.log(
    formatWhyStopped({
      status,
      hasAnyWrites,
      envBlocked,
      lastPolicyEvents,
      ...(topBlockedReason ? { topBlockedReason } : {}),
      ...(blockedAttempts ? { blockedAttempts } : {}),
    }),
  );
  console.log(
    muted(
      '\n  Tip: run a chat task first, then `/why-stopped` or `/why-stopped latest`. See docs/guides/CHAT_RUN_EVIDENCE_AND_CODING_PROFILE.md.\n',
    ),
  );
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function handleStats(ctx: ReplContext, args: string[]): void {
  const runArg = args[0]?.toLowerCase() === 'run' ? args[1] : args[0];
  const summary = globalCostTracker.getSessionSummary();
  console.log(primary('\n  Session Stats:'));
  console.log(`    ${muted(padRight('Stages', 14))} ${ctx.currentStageIdx}/4`);
  console.log(
    `    ${muted(padRight('Session Cost', 14))} ${accentBright('$' + summary.totalCostUSD.toFixed(6))}`,
  );
  if (ctx.lastRunDir) {
    console.log(`    ${muted(padRight('Last Run', 14))} ${muted(path.basename(ctx.lastRunDir))}`);
  }
  try {
    const runDir = resolveRunDir(ctx, runArg);
    const stats = buildRunStats(runDir);
    console.log('');
    console.log(formatRunStatsHuman(stats));
  } catch {
    console.log(
      muted('\n  No run bundle stats available yet. Run a task or use /stats run <run_dir>.'),
    );
  }
}

// ── History ──────────────────────────────────────────────────────────────────

export function handleHistory(ctx: ReplContext, _args: string[]): void {
  console.log(primary('\n  Command History:'));
  const history = (ctx.rl as any).history as string[];
  history
    .slice()
    .reverse()
    .forEach((h, i) => {
      console.log(`    ${muted((i + 1).toString().padStart(3) + '.')} ${h}`);
    });
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export function handleDashboard(ctx: ReplContext, _args: string[]): void {
  const stats = globalCostTracker.getSessionSummary();
  const width = getTerminalWidth();

  process.stdout.write('c'); // clear screen
  process.stdout.write(renderOperatorHeader(ctx.state as unknown as Record<string, unknown>));

  console.log(
    primary(`\n  ${bold('SESSION DASHBOARD')} ${muted('─'.repeat(Math.max(0, width - 22)))}\n`),
  );

  const col1 = 18;
  console.log(
    `    ${muted(padRight('Active Project', col1))} ${accentBright(ctx.state.project ?? 'global (auto-detect)')}`,
  );
  console.log(
    `    ${muted(padRight('Session Mode', col1))} ${accentBright(describeVisibleMode(ctx.state.mode))}`,
  );
  console.log(
    `    ${muted(padRight('Active Model', col1))} ${ctx.state.model ?? muted('auto-selected')}`,
  );

  const tokenIn = Object.values(stats.modelBreakdown).reduce((s, m) => s + m.inputTokens, 0);
  const tokenOut = Object.values(stats.modelBreakdown).reduce((s, m) => s + m.outputTokens, 0);

  console.log(primary(`\n  ${bold('FINANCIALS')} ${muted('─'.repeat(Math.max(0, width - 15)))}\n`));
  console.log(
    `    ${muted(padRight('Total Spend', col1))} ${accentBright('$' + stats.totalCostUSD.toFixed(6))}`,
  );
  console.log(`    ${muted(padRight('Tokens In', col1))} ${tokenIn.toLocaleString()}`);
  console.log(`    ${muted(padRight('Tokens Out', col1))} ${tokenOut.toLocaleString()}`);

  console.log(
    primary(`\n  ${bold('CAPABILITIES')} ${muted('─'.repeat(Math.max(0, width - 17)))}\n`),
  );
  console.log(`    ${muted('✓')} ${dim('Persistence')}  ${muted('enabled (.babel_history)')}`);
  console.log(`    ${muted('✓')} ${dim('Interactive')}  ${muted('enabled (checklist review)')}`);
  console.log(`    ${muted('✓')} ${dim('HUD Waterfall')} ${muted('active (hot-file activity)')}`);

  console.log(muted('\n  Next: /mode chat  /help  /inspect\n'));
}
