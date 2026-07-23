// ─── Service / Plugin / Agent / Recovery Command Handlers ────────────────────
// Extracted from interactive.ts — plugins, checkpoints, agents, git, sessions,
// scrollback pager, and reverse history search.

import type * as readline from 'node:readline/promises';
import type { ReplContext } from '../context.js';
import { installKeyHandler, type KeyEvent } from '../../ui/keyInput.js';
import { resolveRunDir } from './info.js';
import {
  formatPluginDoctorHuman,
  formatPluginListHuman,
  loadPluginRegistry,
  runPluginCommand as runPluginServiceCommand,
} from '../../services/plugins.js';
import {
  findCheckpoint,
  formatCheckpointInspect,
  formatCheckpointList,
  listCheckpoints,
  restoreCheckpoint,
} from '../../services/checkpoints.js';
import {
  formatAgentListHuman,
  formatAgentMergeHuman,
  formatAgentRunHuman,
  inspectAgentRun,
  listAgentRuns,
  mergeAgentRun,
  runAgentTeamFromFile,
  type AgentIsolationMode,
} from '../../services/agentTeams.js';
import {
  readExecutorSessionContext,
  summarizeExecutorSessionContext,
} from '../../services/sessionContext.js';
import { formatShipHuman, runShip } from '../../services/ship.js';
import {
  exportEvidenceBundle,
  formatEvidenceExportHuman,
  formatEvidenceOpenHuman,
  openEvidence,
} from '../../services/evidenceProduct.js';
import {
  buildLiteContinueAssessment,
  findLatestWorkerChainManifest,
  formatLiteContinueAssessmentHuman,
  resumeLiteWorkerChain,
} from '../../services/liteRecovery.js';
import {
  formatLiteRouteSummary,
  formatWorkerChainStatusHuman,
  printLiteSessionActivity,
} from '../../ui/liteSessionActivity.js';
import { renderErrorPanel } from '../../ui/renderers.js';
import { PagerOverlay } from '../../ui/pagerOverlay.js';
import { getActiveRenderer } from '../../ui/waterfall.js';
import type { ConversationalRenderer } from '../../ui/waterfall.js';
import { runGitCommand } from '../../utils/gitExec.js';
import { loadInspectBundle, buildInspectRunView } from '../../inspect/loaders.js';
import { accentBright, error, muted, primary, padRight } from '../../ui/theme.js';

// ── Plugins ──────────────────────────────────────────────────────────────────

export function handlePlugins(_ctx: ReplContext, args: string[]): void {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === 'doctor') {
    console.log('\n' + formatPluginDoctorHuman(loadPluginRegistry()));
    return;
  }
  console.log('\n' + formatPluginListHuman(loadPluginRegistry()));
  console.log(muted('\n  Slash: /plugin <plugin_id> <command> [args...]'));
  console.log(muted('  CLI: babel plugins list|inspect|enable|disable|doctor|command'));
}

export async function handlePluginCommand(_ctx: ReplContext, args: string[]): Promise<void> {
  const pluginId = args[0];
  const commandName = args[1];
  if (!pluginId || !commandName) {
    console.log(accentBright('\n  Usage: /plugin <plugin_id> <command> [args...]'));
    return;
  }

  const result = await runPluginServiceCommand(pluginId, commandName, args.slice(2));
  if (result.exit_code === 0) {
    console.log('\n' + result.stdout.trimEnd());
  } else {
    console.log(accentBright('\n  ' + result.stderr));
  }
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

export function handleCheckpoint(ctx: ReplContext, args: string[]): void {
  const subcommand = args[0]?.toLowerCase() ?? 'list';
  try {
    if (subcommand === 'list') {
      const runDir = resolveRunDir(ctx, args[1]);
      console.log('\n' + formatCheckpointList(listCheckpoints(runDir)));
      return;
    }
    if (subcommand === 'inspect') {
      const checkpointId = args[1];
      if (!checkpointId) {
        console.log(accentBright('\n  Usage: /checkpoint inspect <id> [run]'));
        return;
      }
      const runDir = args[2] ? resolveRunDir(ctx, args[2]) : undefined;
      const resolved = runDir
        ? findCheckpoint(checkpointId, { runDir })
        : findCheckpoint(checkpointId);
      console.log('\n' + formatCheckpointInspect(resolved.record));
      return;
    }
    if (subcommand === 'restore') {
      handleRestore(ctx, args.slice(1));
      return;
    }
    console.log(accentBright('\n  Usage: /checkpoint [list|inspect|restore] ...'));
  } catch (error) {
    console.log(
      '\n' +
        renderErrorPanel(
          'Checkpoint Error',
          error instanceof Error ? error.message : String(error),
          'Use /checkpoint list to see available checkpoints',
        ),
    );
  }
}

export function handleRestore(ctx: ReplContext, args: string[]): void {
  const checkpointId = args[0];
  if (!checkpointId) {
    console.log(accentBright('\n  Usage: /restore <checkpoint_id> [--force]'));
    return;
  }
  try {
    const force = args.includes('--force');
    const runArg = args.find((arg) => arg !== checkpointId && arg !== '--force');
    const runDir = runArg ? resolveRunDir(ctx, runArg) : undefined;
    const resolved = runDir
      ? findCheckpoint(checkpointId, { runDir })
      : findCheckpoint(checkpointId);
    const result = restoreCheckpoint(resolved.record, { force });
    console.log('\n' + JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(
      '\n' +
        renderErrorPanel(
          'Restore Failed',
          error instanceof Error ? error.message : String(error),
          'Check the checkpoint ID with /checkpoint list',
        ),
    );
  }
}

// ── Session ──────────────────────────────────────────────────────────────────

export function handleSession(ctx: ReplContext, args: string[]): void {
  const runArg = args[0]?.toLowerCase() === 'resume' ? args[1] : args[0];
  try {
    const runDir = resolveRunDir(ctx, runArg);
    const bundle = loadInspectBundle(runDir);
    const view = buildInspectRunView(bundle);
    const checkpoints = listCheckpoints(runDir);
    const modelContext = summarizeExecutorSessionContext(readExecutorSessionContext(runDir));
    console.log(primary('\n  Session Resume:'));
    console.log(`    ${muted(padRight('Run', 14))} ${runDir}`);
    console.log(`    ${muted(padRight('Status', 14))} ${view.finalStatus}`);
    console.log(`    ${muted(padRight('Checkpoints', 14))} ${checkpoints.checkpoints.length}`);
    console.log(
      `    ${muted(padRight('Context', 14))} ${modelContext.available ? modelContext.status : 'Unavailable'}`,
    );
    console.log(
      muted(`\n  Next: /inspect  /checkpoint list "${runDir}"  babel resume --run "${runDir}"`),
    );
  } catch (error) {
    console.log(
      '\n' +
        renderErrorPanel(
          'Session Error',
          error instanceof Error ? error.message : String(error),
          'Check available runs with /runs',
        ),
    );
  }
}

export async function handleContinue(ctx: ReplContext, args: string[]): Promise<void> {
  const assessOnly = args[0]?.toLowerCase() === 'assess';
  const runRef = assessOnly ? (args[1] ?? 'latest') : (args[0] ?? 'latest');
  const target = ctx.resolveCurrentTarget();
  const continueOptions = {
    run: runRef,
    ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
    projectRoot: target.targetRoot,
  };

  if (!assessOnly) {
    const resumed = await resumeLiteWorkerChain(continueOptions);
    if (resumed) {
      const payload = resumed.payload as Record<string, unknown>;
      const runDir = typeof payload['run_dir'] === 'string' ? payload['run_dir'] : null;
      ctx.lastRunDir = runDir;
      ctx.state.lastRunUserStatus = resumed.exitCode === 0 ? 'complete' : 'failed';
      if (resumed.humanText) {
        console.log(`\n${resumed.humanText}\n`);
      }
      printLiteSessionActivity(payload, runDir, (line) => console.log(muted(line)));
      const routeSummary = formatLiteRouteSummary(payload);
      if (routeSummary) {
        console.log(muted(`  ${routeSummary}\n`));
      }
      if (resumed.exitCode !== 0) {
        ctx.state.lastRunUserStatus = 'failed';
      }
      return;
    }
  }

  const assessment = buildLiteContinueAssessment(continueOptions);
  console.log(`\n${formatLiteContinueAssessmentHuman(assessment)}\n`);
  if (assessment.status !== 'CONTINUE_READY' && assessment.status !== 'CHAIN_COMPLETE') {
    ctx.state.lastRunUserStatus = 'blocked';
  }
}

export function handleChain(ctx: ReplContext, args: string[]): void {
  const target = ctx.resolveCurrentTarget();
  const manifest = findLatestWorkerChainManifest(target.targetRoot, args[0] ?? 'latest');
  if (!manifest) {
    console.log(muted('\n  No worker chain manifest found for the current target.'));
    console.log(
      muted(
        '  Start a worker chain with: babel do "describe the task" (BABEL_LITE_WORKER_CHAIN=1)\n',
      ),
    );
    return;
  }
  console.log(`\n${formatWorkerChainStatusHuman(manifest)}\n`);
}

// ── Agents ───────────────────────────────────────────────────────────────────

export function parseAgentIsolation(args: string[]): AgentIsolationMode | undefined {
  const flagIndex = args.indexOf('--isolation');
  const value = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  if (!value) {
    return undefined;
  }
  if (value !== 'copy' && value !== 'git_worktree' && value !== 'none') {
    throw new Error(`Invalid isolation mode: ${value}`);
  }
  return value;
}

export function handleAgents(ctx: ReplContext, args: string[]): void {
  const subcommand = args[0]?.toLowerCase() ?? 'list';
  const isLive = args.includes('--live');
  try {
    if (subcommand === 'list') {
      console.log('\n' + formatAgentListHuman(listAgentRuns()));
      return;
    }
    if (subcommand === 'run') {
      if (isLive) {
        // Live sub-agent execution path: filter out --live flag to get the agent-id
        const liveArgs = args.filter((a) => a !== '--live');
        const agentId = liveArgs[1];
        if (!agentId) {
          console.log(
            accentBright('\n  Usage: /agents run --live <agent-id> [task description...]'),
          );
          console.log(
            muted('  Launches a live mutation sub-agent with worktree isolation and rollback.'),
          );
          return;
        }
        const task = liveArgs.slice(2).join(' ') || 'Execute the specified task';
        console.log(
          accentBright(`\n  Launching live sub-agent "${agentId}": "${task.slice(0, 100)}"\n`),
        );
        console.log(
          muted(
            '  Live sub-agents require an AgentSession context.\n' +
              '  Use `babel chat` or the CLI pipeline to execute live sub-agents.\n' +
              '  For direct testing, use the runMutationAgentLoop() API.\n',
          ),
        );
        return;
      }
      const spec = args[1];
      if (!spec) {
        console.log(
          accentBright('\n  Usage: /agents run <spec.json> [--isolation copy|git_worktree|none]'),
        );
        return;
      }
      const isolation = parseAgentIsolation(args);
      const run = runAgentTeamFromFile(spec, {
        ...(isolation ? { isolation } : {}),
      });
      console.log('\n' + formatAgentRunHuman(run));
      return;
    }
    if (subcommand === 'inspect') {
      const id = args[1];
      if (!id) {
        console.log(accentBright('\n  Usage: /agents inspect <id>'));
        return;
      }
      console.log('\n' + formatAgentRunHuman(inspectAgentRun(id)));
      return;
    }
    if (subcommand === 'merge') {
      const id = args[1];
      if (!id) {
        console.log(accentBright('\n  Usage: /agents merge <id>'));
        return;
      }
      console.log('\n' + formatAgentMergeHuman(mergeAgentRun(id)));
      return;
    }
    console.log(accentBright('\n  Usage: /agents [list|run|inspect|merge] ...'));
  } catch (error) {
    console.log(
      '\n' +
        renderErrorPanel(
          'Agent Error',
          error instanceof Error ? error.message : String(error),
          'Use /agents list to see available agents',
        ),
    );
  }
}

// ── Git ──────────────────────────────────────────────────────────────────────

export async function handleGit(ctx: ReplContext, args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();
  const target = ctx.resolveCurrentTarget();
  const cwd = target.targetRoot;

  try {
    let output: string;
    let title: string;
    switch (sub) {
      case 'status': {
        const result = await runGitCommand(['status', '--short'], cwd);
        output = result.stdout.trim() || '(working tree clean)';
        title = 'Git Status';
        break;
      }
      case 'diff': {
        const result = await runGitCommand(['diff', '--stat', '--color=never'], cwd);
        output = result.stdout.trim() || '(no unstaged changes)';
        title = 'Git Diff';
        break;
      }
      case 'log': {
        const result = await runGitCommand(['log', '--oneline', '-n', '15', '--color=never'], cwd);
        output = result.stdout.trim() || '(no commits)';
        title = 'Git Log';
        break;
      }
      default:
        console.log(accentBright('\n  Usage: /git <status|diff|log>'));
        console.log(muted('  /git status   Show working tree status'));
        console.log(muted('  /git diff     Show unstaged changes (stat)'));
        console.log(muted('  /git log      Show recent commits'));
        return;
    }
    console.log(primary(`\n  ${title}:`));
    if (output.length > 0) {
      const lines = output.split('\n');
      const maxLines = 30;
      const display = lines.slice(0, maxLines);
      for (const line of display) {
        console.log(muted(`  ${line}`));
      }
      if (lines.length > maxLines) {
        console.log(muted(`  ... (${lines.length - maxLines} more lines)`));
      }
    }
    console.log('');
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    console.log(error(`\n  Git failed: ${msg.split('\n')[0]}`));
    console.log(muted('  Ensure the current project is a git repository.\n'));
  }
}

// ── Ship (W3.1) ──────────────────────────────────────────────────────────────

/**
 * /ship [apply] [allow-remote] [check <cmd>]
 * Dry-run by default — runs secret scan + evidence PR body via runShip.
 */
export function handleShip(ctx: ReplContext, args: string[]): void {
  const target = ctx.resolveCurrentTarget();
  const projectRoot = target.targetRoot;
  let apply = false;
  let allowRemote = false;
  let allowMain = false;
  let allowMixed = false;
  const checks: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.toLowerCase();
    if (a === 'apply' || a === '--apply') apply = true;
    else if (a === 'allow-remote' || a === '--allow-remote') allowRemote = true;
    else if (a === 'allow-main' || a === '--allow-main') allowMain = true;
    else if (a === 'allow-mixed' || a === '--allow-mixed') allowMixed = true;
    else if ((a === 'check' || a === '--check') && args[i + 1]) {
      checks.push(args[++i]!);
    } else if (a === 'help' || a === '--help') {
      console.log(primary('\n  /ship — implementor ship (dry-run default)'));
      console.log(muted('  /ship'));
      console.log(muted('  /ship check "npm test"'));
      console.log(muted('  /ship apply'));
      console.log(muted('  /ship apply allow-remote check "npm test"'));
      console.log(muted('  Uses last run for evidence PR body when available.\n'));
      return;
    }
  }

  try {
    const report = runShip({
      projectRoot,
      apply,
      dryRun: !apply,
      allowRemote,
      allowMain,
      allowMixed,
      checkCommands: checks,
      ...(ctx.state.lastRunDir ? { evidenceRunDir: ctx.state.lastRunDir } : {}),
      ...(ctx.state.lastTask ? { task: ctx.state.lastTask } : {}),
    });
    console.log(primary('\n  Ship:\n'));
    for (const line of formatShipHuman(report).split('\n')) {
      console.log(muted(`  ${line}`));
    }
    console.log('');
    if (report.status === 'blocked' || report.status === 'failed') {
      console.log(accentBright('  Ship blocked or failed — resolve hard stops and retry.\n'));
    }
  } catch (err) {
    console.log(error(`\n  Ship failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

// ── Evidence (W3.2) ──────────────────────────────────────────────────────────

/**
 * /evidence [open|export] [run-path]
 */
export function handleEvidence(ctx: ReplContext, args: string[]): void {
  const sub = (args[0] ?? 'open').toLowerCase();
  const runArg =
    args[1] ??
    (sub !== 'open' && sub !== 'export' && !sub.startsWith('-') ? args[0] : undefined);

  try {
    if (sub === 'export') {
      const opened = openEvidence({
        ...(runArg ? { run: runArg } : {}),
        lastRunDir: ctx.state.lastRunDir ?? null,
      });
      if (!opened.run_dir) {
        console.log(accentBright('\n  No evidence run to export.\n'));
        console.log(muted(formatEvidenceOpenHuman(opened)));
        return;
      }
      const report = exportEvidenceBundle({ runDir: opened.run_dir });
      console.log(primary('\n  Evidence export:\n'));
      for (const line of formatEvidenceExportHuman(report).split('\n')) {
        console.log(muted(`  ${line}`));
      }
      console.log('');
      return;
    }

    // default open (also /evidence <path>)
    const run =
      sub === 'open' || sub === 'latest'
        ? runArg
        : sub.startsWith('.') || sub.includes('/') || sub.includes('\\')
          ? sub
          : runArg;
    const report = openEvidence({
      ...(run ? { run } : {}),
      lastRunDir: ctx.state.lastRunDir ?? null,
    });
    console.log(primary('\n  Evidence open:\n'));
    for (const line of formatEvidenceOpenHuman(report).split('\n')) {
      console.log(muted(`  ${line}`));
    }
    console.log('');
  } catch (err) {
    console.log(
      error(`\n  Evidence command failed: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  }
}

// ── Scrollback Pager ─────────────────────────────────────────────────────────

function asConversationalRenderer(
  renderer: ReturnType<typeof getActiveRenderer>,
): ConversationalRenderer | null {
  if (!renderer || !('getHistoryCellViewport' in renderer)) {
    return null;
  }
  return renderer as ConversationalRenderer;
}

export async function handleScrollback(ctx: ReplContext, _args: string[]): Promise<void> {
  if (!ctx.screenManager) {
    console.log(
      muted(
        '\n  Scrollback buffer not available. Start a task to populate the buffer and wire a ScreenManager.\n',
      ),
    );
    return;
  }

  const conv = asConversationalRenderer(getActiveRenderer());
  const cellViewport =
    conv?.getHistoryCellViewport() ?? ctx.screenManager.getHistoryCellViewport();

  if (cellViewport && cellViewport.totalRowCount > 0) {
    await PagerOverlay.showFromViewport(cellViewport);
    ctx.printIdleHeader();
    return;
  }

  const buffer = ctx.screenManager.getScrollback();
  if (!buffer || buffer.totalLines === 0) {
    console.log(
      muted(
        '\n  Scrollback buffer is empty. Output must be written through ScreenManager to be captured.\n',
      ),
    );
    return;
  }
  await PagerOverlay.show(buffer);
  // After the pager exits, redraw the REPL prompt
  ctx.printIdleHeader();
}

// ── Reverse History Search ───────────────────────────────────────────────────

/**
 * Shared reverse history search engine.
 *
 * Drives an interactive reverse-i-search overlay on the readline prompt.
 * The caller provides the readline interface and history array; this function
 * handles all key events, match cycling (Ctrl+R), selection (Enter), and
 * cancellation (Ctrl+C / Escape).
 *
 * Behavior preserved from the two original inlined implementations in
 * BabelRepl.handleReverseSearch and handleReverseSearch (this module):
 *
 *   - Ctrl+R cycles backward through query matches
 *   - Enter selects the current match and writes it to the prompt
 *   - Ctrl+C / Escape cancel and restore the original prompt
 *   - Backspace removes the last query character
 *   - Printable characters append to the query
 */
export function reverseHistorySearch(rl: readline.Interface, history: string[]): Promise<void> {
  if (history.length === 0) return Promise.resolve();
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.resolve();

  let query = '';
  let matchIdx = -1;
  const originalPrompt = (rl as any)._prompt ?? '> ';

  const draw = () => {
    const match = query
      ? history
          .filter((_h, i) => {
            if (history[i]!.includes(query)) {
              matchIdx = i;
              return true;
            }
            return false;
          })
          .slice(-1)[0]
      : null;
    const display = match ? match.slice(0, 80) + (match.length > 80 ? '...' : '') : '';
    stdout.write(`\r\x1b[K(reverse-i-search)\`${query}': ${display}`);
  };

  return new Promise<void>((resolve) => {
    const cleanupKeys = installKeyHandler(stdin, (event: KeyEvent) => {
      if (event.ctrl && event.name === 'r') {
        if (query) {
          const matches = history.filter((h) => h.includes(query));
          if (matches.length > 0) {
            const sorted = [...matches].reverse();
            const foundIdx = sorted.findIndex((h) => h === history[matchIdx]);
            matchIdx = foundIdx >= 0 ? foundIdx : -1;
            const next = sorted[(matchIdx + 1) % sorted.length];
            if (next) {
              matchIdx = history.indexOf(next);
              const display = next.slice(0, 80) + (next.length > 80 ? '...' : '');
              stdout.write(`\r\x1b[K(reverse-i-search)\`${query}': ${display}`);
            }
          }
        }
        return;
      }

      if (event.name === 'enter') {
        const selected = query ? history.filter((h) => h.includes(query)).slice(-1)[0] : null;
        cleanupKeys();
        stdout.write('\r\x1b[K');
        rl.setPrompt(originalPrompt);
        if (selected) {
          stdout.write('\n');
          rl.write(selected);
        }
        resolve();
        return;
      }

      if ((event.name === 'c' && event.ctrl) || event.name === 'escape') {
        cleanupKeys();
        stdout.write('\r\x1b[K\n');
        rl.setPrompt(originalPrompt);
        rl.prompt();
        resolve();
        return;
      }

      if (event.name === 'backspace') {
        query = query.slice(0, -1);
        draw();
        return;
      }
      if (event.sequence && event.sequence.length === 1 && event.sequence >= ' ') {
        query += event.sequence;
        draw();
      }
    });

    draw();
  });
}

/** Command handler: wraps reverseHistorySearch with the ReplContext interface. */
export async function handleReverseSearch(ctx: ReplContext): Promise<void> {
  const history = (ctx.rl as any).history as string[];
  await reverseHistorySearch(ctx.rl, history);
}
