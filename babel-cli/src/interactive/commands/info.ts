import { resolveRuntimePaths } from '../../config/runtimePaths.js';
import { runInstalledDoctor } from '../../installedDoctor.js';
import { inspectRunningProduct, runningProduct } from '../../services/runningProduct.js';
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
import { nextFallbackEntry, resolveModelSnapshot } from './modelDetail.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { buildRunStats, formatRunStatsHuman } from '../../services/runStats.js';
import { runDoctor, formatDoctorHuman } from '../../doctor.js';
import { BABEL_ROOT } from '../../cli/constants.js';
import { chatSessionDir, resolveBabelRunsDir } from '../../cli/runsLayout.js';
import { copyFileToClipboard } from '../../cli/helpers.js';
import { copyToClipboardWithFeedback, isClipboardSupported } from '../../ui/clipboard.js';
import { renderChatTranscript } from '../../ui/chatPanel.js';
import { highlightCodeBlocks } from '../../ui/highlight.js';
import { renderErrorPanel, renderOperatorHeader } from '../../ui/renderers.js';
import { formatUsageCost } from '../../cli/usageCost.js';
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
import { terminalReasonGuidance } from '../../agent/chatTerminalReason.js';
import { TerminalReasonCodeSchema } from '../../schemas/agentContracts.js';
import { readDurableTerminalTruth } from '../../services/durableTerminalTruth.js';

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
  const product = inspectRunningProduct(runningProduct);
  console.log(`    ${muted(padRight('Babel', 10))} ${product.runningVersion ?? 'unknown'} (revision ${product.revision ?? 'unknown'})`);
  console.log(`    ${muted(padRight('Package', 10))} ${product.packageRoot}`);
  console.log(`    ${muted(padRight('Entry', 10))} ${product.entrypoint ?? 'unknown'}`);
  if (product.restartNeeded) console.log('    Package files changed; restart to use the current installation.');
  else if (product.restartNeeded === null) console.log('    Installation change detection: unknown.');
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
  const snapshot = resolveModelSnapshot(ctx.state.model);
  if (snapshot) {
    console.log(
      `    ${muted(padRight('Provider', 10))} ${accentBright(snapshot.policy.provider)} ${muted('→')} ${muted(snapshot.policy.providerModelId)}`,
    );
    const fallback = nextFallbackEntry(snapshot.policy);
    if (fallback) {
      console.log(
        `    ${muted(padRight('Fallback', 10))} ${muted(fallback.backendKey)}`,
      );
    }
  } else if (ctx.state.resolvedModelId) {
    console.log(`    ${muted(padRight('Route', 10))} ${muted(ctx.state.resolvedModelId)}`);
  }
  console.log(
    `    ${muted(padRight('Verbose', 10))} ${ctx.verboseMode ? accentBright('on') : muted('off')}\n`,
  );
}

export async function handleDoctor(ctx: ReplContext, args: string[]): Promise<void> {
  try {
    if (resolveRuntimePaths().isInstalled && !args.includes('--contributor')) {
      const executionPolicy = ctx.chatEngine?.getExecutionPolicy();
      const report = runInstalledDoctor({
        strict: args.includes('--strict'),
        ...(executionPolicy ? { executionPolicy } : {}),
      });
      console.log('\n' + report.checks.map(check => `${check.status}: ${check.id} — ${check.message}`).join('\n'));
      return;
    }
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

// ── Why stopped ─────────────────────────────────────────────────────────────

/** Explain the terminal recorded for the current conversation or selected run. */
export function handleWhyStopped(ctx: ReplContext, args: string[]): void {
  const selection = args.join(' ').trim().replace(/^"(.+)"$/, '$1');
  const explicit = selection !== '' && selection.toLowerCase() !== 'latest';
  const sessionId = ctx.chatEngine?.getEngineRunId?.();
  const latestRun = ctx.turns.filter((turn) => turn.role === 'assistant').at(-1)?.run_dir;
  let runDir = latestRun ?? (sessionId ? chatSessionDir(sessionId) : null);
  let expectedSessionId = latestRun ? undefined : sessionId;
  if (explicit) {
    runDir = path.resolve(selection);
    expectedSessionId = undefined;
    if (/^[\w-]{1,80}$/.test(selection)) {
      const conversationDir = chatSessionDir(selection);
      const savedRunDir = path.join(resolveBabelRunsDir(), selection);
      if (fs.existsSync(conversationDir)) {
        runDir = conversationDir;
        expectedSessionId = selection;
      } else if (fs.existsSync(savedRunDir)) {
        runDir = savedRunDir;
      }
    }
  }
  console.log(primary('\n  Why stopped:\n'));
  if (!runDir) {
    console.log('    No recorded run in this conversation. Use /why-stopped <run-dir> to inspect a saved run.');
    return;
  }
  const truth = readDurableTerminalTruth(runDir, expectedSessionId);
  console.log(`    ${explicit ? 'Selected run' : 'Conversation run'}: ${path.basename(runDir)}`);
  if (truth.turn_id) console.log(`    Turn: ${truth.turn_id}`);
  console.log(`    Outcome: ${truth.outcome ?? truth.status ?? 'No durable outcome recorded'}`);
  if (truth.reason_code) {
    const reason = TerminalReasonCodeSchema.safeParse(truth.reason_code);
    const guidance = reason.success ? terminalReasonGuidance(reason.data) : null;
    console.log(`    Reason: ${truth.reason_code}${guidance ? ` — ${guidance.message}` : ''}`);
  }
  const changedFiles = [...new Set(truth.changed_files)];
  if (changedFiles.length > 0) {
    console.log(`    Recorded changed files (${changedFiles.length}): ${changedFiles.join(', ')}`);
  }
  if (truth.corrupt) console.log(`    Unreadable evidence: ${truth.corrupt_sources.join(', ')}`);
  else if (truth.disagreement) console.log('    Durable records disagree; the outcome shown is conservative.');
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function handleStats(ctx: ReplContext, args: string[]): void {
  const runArg = args[0]?.toLowerCase() === 'run' ? args[1] : args[0];
  const summary = globalCostTracker.getSessionSummary();
  console.log(primary('\n  Session Stats:'));
  console.log(`    ${muted(padRight('Stages', 14))} ${ctx.currentStageIdx}/4`);
  console.log(
    `    ${muted(padRight('Session Cost', 14))} ${accentBright(formatUsageCost(summary))}`,
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
    `    ${muted(padRight('Total Spend', col1))} ${accentBright(formatUsageCost(stats))}`,
  );
  console.log(`    ${muted(padRight('Tokens In', col1))} ${tokenIn.toLocaleString()}`);
  console.log(`    ${muted(padRight('Tokens Out', col1))} ${tokenOut.toLocaleString()}`);

  console.log(
    primary(`\n  ${bold('CAPABILITIES')} ${muted('─'.repeat(Math.max(0, width - 17)))}\n`),
  );
  console.log(`    ${muted('✓')} ${dim('Persistence')}  ${muted('enabled (private profile history)')}`);
  console.log(`    ${muted('✓')} ${dim('Interactive')}  ${muted('enabled (checklist review)')}`);
  console.log(`    ${muted('✓')} ${dim('HUD Waterfall')} ${muted('active (hot-file activity)')}`);

  console.log(muted('\n  Next: /mode chat  /help  /inspect\n'));
}
