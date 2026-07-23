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
import { primary, error, muted } from '../../ui/theme.js';
import type { ReplContext } from '../context.js';
import type { SessionState } from '../types.js';
import * as Session from '../session.js';

export function exitRepl(): void {
  delete process.env['BABEL_INTERACTIVE'];
  logUpdate.clear();
  OutputBuffer.getInstance().write('\x1b[?25h');
  console.log(primary('  Babel session ended. See you next run.\n'));
  process.exit(0);
}

export async function bootstrapReplSession(
  ctx: ReplContext,
  loadSessionState: () => SessionState | null,
): Promise<void> {
  OutputBuffer.getInstance().write('\x1b[2J\x1b[H');
  warmReplRuntime();
  startBackgroundIndexing();

  const saved = loadSessionState();
  if (saved?.costTotals) {
    try {
      globalCostTracker.restoreSessionCost(saved.costTotals);
    } catch {
      /* non-critical */
    }
  }

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

export async function maybeShowResumePicker(ctx: ReplContext): Promise<void> {
  if (!process.stdout.isTTY || process.env['CI'] || process.env['BABEL_SKIP_RESUME_PICKER'] === '1') {
    return;
  }
  const sessions = await listResumableSessions({ limit: 20 });
  if (sessions.length === 0) return;

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