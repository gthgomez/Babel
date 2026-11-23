import { resolveEffectiveSettings } from '../../config/userSettings.js'
import { canPromptForSetup, getSetupStatus } from '../../services/providerSetup.js'
import { connectionModelSelector } from '../../config/connectionModelPolicy.js'
import { setupReplConnection } from './replProviderSetup.js'
import process from 'node:process';

import logUpdate from 'log-update';
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
  const effective = resolveEffectiveSettings({ projectRoot: target, reportUnavailableConnection: true,
    ...(ctx.state.connectionId ? { session: { connection: ctx.state.connectionId } } : {}) })
  if (!ctx.state.model && effective.connection.value && effective.model.value) {
    ctx.state.model = connectionModelSelector(effective.connection.value.id, effective.model.value)
    ctx.state.connectionId = effective.connection.value.id
    ctx.state.modelSource = effective.model.source
    ctx.resolveSessionModel()
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
  const status = getSetupStatus(process.env, ctx.state.connectionId ? { connection: ctx.state.connectionId } : {}, target)
  ctx.state.readinessState = status.state
  if (isFirstRun()) showOnboarding(status.state !== 'configured_unverified')
  if ((!ctx.state.model || status.state === 'action_required') &&
      !process.env['BABEL_RESUME_SESSION']?.trim() && canPromptForSetup()) {
    await setupReplConnection(ctx)
  }
  const canWarm = ctx.state.model && ctx.state.readinessState !== 'action_required'
  recordInteractiveDiagnostic('startup', `Setup state: ${ctx.state.readinessState}; runtime warmup: ${canWarm ? 'eligible' : 'skipped'}`)
  if (!canWarm) ctx.state.lastRunUserStatus = 'blocked'
  if (canWarm) {
    if (typeof hooks.warmRuntime === 'function') hooks.warmRuntime()
    else if (hooks.warmRuntime !== false && process.env['NODE_ENV'] !== 'test' && !process.env['BABEL_TEST']) warmReplRuntime()
    if (typeof hooks.startIndexing === 'function') hooks.startIndexing()
    else if (hooks.startIndexing !== false && !resolveRuntimePaths().isInstalled && process.env['NODE_ENV'] !== 'test' && !process.env['BABEL_TEST']) startBackgroundIndexing()
  }
  void readRuntimeMode()

}

export { formatResumeHint, shouldForceResumePicker } from './startupResumeHint.js';

export async function maybeShowResumePicker(ctx: ReplContext): Promise<void> {
  const requested = process.env['BABEL_RESUME_SESSION']?.trim();
  if (requested) {
    const id =
      requested === 'latest' || requested === '1'
        ? (await listResumableSessions({ limit: 1 }))[0]?.id
        : requested;
    const buf = OutputBuffer.getInstance();
    if (id) {
      const { resumeChatSession } = await import('../chatSessionResume.js');
      const outcome = await resumeChatSession(ctx, id);
      if (outcome.ok) {
        buf.write(primary(`\n  Resumed ${id} — ${outcome.turnCount} turns loaded\n`));
        buf.write(muted('  Type a message to continue, or /help for commands.\n'));
      } else {
        buf.write(error(`\n  ${outcome.reason === 'cancelled' ? outcome.message : `Failed to resume ${id}: ${outcome.message}`}\n`));
      }
    } else buf.write(error('\n  No saved session was found to resume.\n'));
    ctx.isRunning = false;
    return;
  }

  if (!process.stdout.isTTY || process.env['CI'] ||
      ctx.state.readinessState === 'setup_required' || ctx.state.readinessState === 'action_required') return;
  const sessions = await listResumableSessions({ limit: 20 });
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
      buf.write(error(`\n  ${outcome.reason === 'cancelled' ? outcome.message : `Failed to resume ${choice.sessionId}: ${outcome.message}`}\n`));
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
