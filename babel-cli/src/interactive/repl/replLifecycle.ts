import process from 'node:process';

import logUpdate from 'log-update';
import { getAvailableModels } from '../../modelPolicy.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { detectProjectFromCwd } from '../../cli/helpers.js';
import { readRuntimeMode } from '../../config/runtimeMode.js';
import { readProjectSettings, mergeProjectSettings } from '../../config/projectSettings.js';
import { warmReplRuntime } from '../replWarmup.js';
import { startBackgroundIndexing } from '../../services/knowledgeGraphIndexer.js';
import { showOnboarding, isFirstRun } from '../../ui/onboarding.js';
import { listResumableSessions } from '../../services/chatSessionIndex.js';
import { SessionPicker } from '../../ui/sessionPicker.js';
import { OutputBuffer } from '../../ui/outputBuffer.js';
import { InputCoordinator } from '../../ui/inputCoordinator.js';
import { stopTuiObservation } from '../../ui/observe/observeSession.js';
import { DEC_2026_END } from '../../ui/terminalEscapeSequences.js';
import { primary, error, muted } from '../../ui/theme.js';
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
  console.log(primary('  Babel session ended. See you next run.\n'));
  process.exit(0);
}

export async function bootstrapReplSession(
  ctx: ReplContext,
  _loadSessionState: () => SessionState | null,
): Promise<void> {
  // Marks interactive TUI so sandbox notices route through OutputBuffer (not stderr).
  process.env['BABEL_INTERACTIVE'] = '1';
  // Clear viewport + scrollback so prior-session error boxes do not linger above the picker.
  OutputBuffer.getInstance().writeControl('\x1b[2J\x1b[3J\x1b[H');
  warmReplRuntime();
  startBackgroundIndexing();

  // Fresh interactive process: never inherit ~/.babel/session.json cost.
  // Conversation resume is explicit (/resume); do not reload last process totals.
  globalCostTracker.resetSession();

  if (!ctx.projectSettingsApplied) {
    const currentTarget = ctx.resolveCurrentTarget();
    if (currentTarget.targetRoot) {
      const projSettings = readProjectSettings(currentTarget.targetRoot);
      if (Object.keys(projSettings).length > 0) {
        const merged = mergeProjectSettings(ctx.state, projSettings, false);
        ctx.projectSettingsApplied = merged.applied;
        if (merged.mode !== undefined) ctx.state.mode = merged.mode;
        if (merged.model !== undefined) ctx.state.model = merged.model;
        if (merged.model) ctx.resolveSessionModel();
      }
    }
  }

  if (!ctx.state.model) {
    try {
      const available = getAvailableModels();
      const enabled = available.filter((m) => m.entry.enabled !== false);
      if (enabled.length > 0) {
        enabled.sort(
          (a, b) =>
            (a.entry.estimated_cost_per_1m_output ?? Infinity) -
            (b.entry.estimated_cost_per_1m_output ?? Infinity),
        );
        const cheapest = enabled[0]!;
        ctx.state.model = cheapest.key;
        ctx.state.resolvedModelId = cheapest.entry.model_id;
      }
    } catch {
      /* policy optional */
    }
  }

  void readRuntimeMode();
  if (isFirstRun()) {
    showOnboarding();
  }
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
