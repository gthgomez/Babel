import { resolveEffectiveSettings } from '../../config/userSettings.js'
import { getSetupStatus, runProviderSetup } from '../../services/providerSetup.js'
import { selectedConnectionModel } from '../../services/connectionSettings.js'
import process from 'node:process';

import logUpdate from 'log-update';
import { getAvailableModels } from '../../modelPolicy.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { detectProjectFromCwd } from '../../cli/helpers.js';
import { readRuntimeMode } from '../../config/runtimeMode.js';
import { resolveRuntimePaths } from '../../config/runtimePaths.js';
import { readProjectSettings, mergeProjectSettings } from '../../config/projectSettings.js';
import { warmReplRuntime, stopReplWarmup } from '../replWarmup.js';
import { startBackgroundIndexing } from '../../services/knowledgeGraphIndexer.js';
import { showOnboarding, isFirstRun } from '../../ui/onboarding.js';
import { listResumableSessions } from '../../services/chatSessionIndex.js';
import { SessionPicker } from '../../ui/sessionPicker.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';
import { InputCoordinator } from '../../ui/inputCoordinator.js';
import { stopTuiObservation } from '../../ui/observe/observeSession.js';
import { DEC_2026_END } from '../../ui/terminalEscapeSequences.js';
import { primary, error, muted } from '../../ui/theme.js';
import { recordInteractiveDiagnostic } from '../../ui/interactiveDiagnostics.js';
import type { ReplContext } from '../context.js';
import type { SessionState } from '../types.js';
import * as Session from '../session.js';
import { formatResumeHint, shouldForceResumePicker } from './startupResumeHint.js';

/**
 * Restore TTY modes and terminal layout before printing the session-ended
 * line without erasing the user's visible session history. Safe to call more
 * than once.
 */
export function restoreTerminalBeforeExit(): void {
  logUpdate.clear();
  try {
    stopTuiObservation();
  } catch {
    // Observation host may be unused.
  }
  try {
    InputCoordinator.getInstance().emergencyRestore();
  } catch {
    // Coordinator may not be constructed in non-interactive tests.
  }
  try {
    const write = (s: string) => {
      process.stdout.write(s);
    };
    write('\x1b[?25h');
    write('\x1b[0m');
    write('\x1b[r');
    write(DEC_2026_END);
  } catch {
    // stdout may already be closed
  }
}

export function exitRepl(): void {
  delete process.env['BABEL_INTERACTIVE'];
  restoreTerminalBeforeExit();
  void (async () => {
    let exitCode = 0;
    try {
      await stopReplWarmup();
      console.log(primary('  Babel session ended. See you next run.\n'));
    } catch (err: unknown) {
      console.error(`[babel] Daemon cleanup failed: ${String(err)}`);
      exitCode = 1;
    }
    process.exit(exitCode);
  })();
}

export interface BootstrapReplHooks {
  warmRuntime?: boolean | (() => void);
  startIndexing?: boolean | (() => void);
}

export async function bootstrapReplSession(
  ctx: ReplContext,
  _loadSessionState: () => SessionState | null,
  hooks: BootstrapReplHooks = {},
): Promise<void> {
  // Marks interactive TUI so sandbox notices route through OutputBuffer (not stderr).
  process.env['BABEL_INTERACTIVE'] = '1';
  // Clear viewport + scrollback so prior-session error boxes do not linger above the picker.
  OutputBuffer.getInstance().writeControl('\x1b[2J\x1b[3J\x1b[H');

  // Configuration and local prerequisites precede indexing or daemon warmup.
  globalCostTracker.resetSession()
  const target = ctx.resolveCurrentTarget().targetRoot ?? process.cwd()
  const effective = resolveEffectiveSettings({ projectRoot: target,
    ...(ctx.state.connectionId ? { session: { connection: ctx.state.connectionId } } : {}) })
  if (!ctx.state.model) {
    const selector = selectedConnectionModel({}, target)
    if (selector) {
      ctx.state.model = selector
      if (effective.connection.value) ctx.state.connectionId = effective.connection.value.id
      ctx.state.modelSource = effective.connection.source
      ctx.resolveSessionModel()
    }
  }
  if (!ctx.state.modeExplicit && (effective.workflow.source !== 'built-in' || effective.review.source !== 'built-in')) {
    ctx.state.mode = effective.workflow.value === 'plan' ? 'plan' : effective.review.value === 'thorough' ? 'deep' : 'chat'
  }
  if (!ctx.projectSettingsApplied) {
    const projectSettings = readProjectSettings(target)
    if (!ctx.state.modeExplicit && effective.workflow.source === 'built-in' && effective.review.source === 'built-in' && projectSettings.mode) ctx.state.mode = projectSettings.mode
    const merged = mergeProjectSettings(ctx.state, projectSettings, false)
    ctx.projectSettingsApplied = true
    // Repository settings cannot select a credential destination for a fresh profile.
    if (!ctx.state.model && merged.model) OutputBuffer.getInstance().write(muted('Legacy project model found. Use /setup to explicitly select its provider and account.\n'))
  }
  if (isFirstRun()) showOnboarding()
  if (!ctx.state.model && process.stdin.isTTY && process.stderr.isTTY && !process.env['CI']) {
    const setup = () => runProviderSetup()
    if (ctx.withExclusiveTerminal) await ctx.withExclusiveTerminal('first-run-setup', setup)
    else await setup()
    const selected = selectedConnectionModel({}, target)
    if (selected) { ctx.state.model = selected; ctx.state.modelSource = 'user'; const id = resolveEffectiveSettings({ projectRoot: target }).connection.value?.id; if (id) ctx.state.connectionId = id; ctx.resolveSessionModel() }
  }
  const status = getSetupStatus(process.env, ctx.state.connectionId ? { connection: ctx.state.connectionId } : {}, target)
  ctx.state.readinessState = status.state
  recordInteractiveDiagnostic('startup', `Setup state: ${status.state}; runtime warmup: ${ctx.state.model && status.state !== 'action_required' ? 'eligible' : 'skipped'}`)
  if (!ctx.state.model || status.state === 'action_required') ctx.state.lastRunUserStatus = 'blocked'
  if (ctx.state.model && status.state !== 'action_required') {
    if (typeof hooks.warmRuntime === 'function') hooks.warmRuntime()
    else if (hooks.warmRuntime !== false && process.env['NODE_ENV'] !== 'test' && !process.env['BABEL_TEST']) warmReplRuntime()
    if (typeof hooks.startIndexing === 'function') hooks.startIndexing()
    else if (hooks.startIndexing !== false && !resolveRuntimePaths().isInstalled && process.env['NODE_ENV'] !== 'test' && !process.env['BABEL_TEST']) startBackgroundIndexing()
  }
  void readRuntimeMode()

}

export { formatResumeHint, shouldForceResumePicker } from './startupResumeHint.js';

export async function maybeShowResumePicker(ctx: ReplContext): Promise<void> {
  if (!process.stdout.isTTY || process.env['CI']) {
    return;
  }

  const sessions = await listResumableSessions({ limit: 20 });
  const requested = process.env['BABEL_RESUME_SESSION']?.trim();
  if (requested) {
    const id =
      requested === 'latest' || requested === '1'
        ? sessions[0]?.id
        : requested;
    if (id) {
      const { resumeChatSession } = await import('../chatSessionResume.js');
      const outcome = await resumeChatSession(ctx, id);
      const buf = OutputBuffer.getInstance();
      if (outcome.ok) {
        buf.write(primary(`\n  Resumed ${id} — ${outcome.turnCount} turns loaded\n`));
        buf.write(muted('  Type a message to continue, or /help for commands.\n'));
      } else {
        buf.write(error(`\n  Failed to resume ${id}: ${outcome.message}\n`));
      }
    }
    ctx.isRunning = false;
    return;
  }

  if (sessions.length === 0) return;

  if (!shouldForceResumePicker() || process.env['BABEL_SKIP_RESUME_PICKER'] === '1') {
    const latest = sessions[0]!;
    OutputBuffer.getInstance().write(muted(`\n${formatResumeHint(latest)}\n`));
    ctx.isRunning = false;
    return;
  }

  const choice = await SessionPicker.show(sessions);
  // Picker already drained stdin; keep isRunning false so idle header + prompt
  // are not suppressed by a phantom task from leaked picker input.
  ctx.isRunning = false;

  if (choice.action === 'resume') {
    const { resumeChatSession } = await import('../chatSessionResume.js');
    const outcome = await resumeChatSession(ctx, choice.sessionId);
    const buf = OutputBuffer.getInstance();
    if (outcome.ok) {
      buf.write(primary(`\n  Resumed ${choice.sessionId} — ${outcome.turnCount} turns loaded\n`));
      buf.write(muted('  Type a message to continue, or /help for commands.\n'));
    } else {
      buf.write(error(`\n  Failed to resume ${choice.sessionId}: ${outcome.message}\n`));
    }
  } else if (choice.action === 'new') {
    OutputBuffer.getInstance().write(muted('\n  Starting a new session.\n'));
  }
  // cancel → fall through to idle header in runReplLoop
}

export function detectInitialProject(): string | undefined {
  const detected = detectProjectFromCwd();
  return detected !== null ? detected : undefined;
}

export { Session };
