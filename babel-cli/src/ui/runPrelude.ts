import type { ValidMode } from '../cli/constants.js';
import { readRuntimeMode } from '../config/runtimeMode.js';
import { printBanner } from '../commands/coreCommands.js';
import { renderPlanModeWarning, renderRunPrelude } from './renderers.js';

export interface TextRunPreludeContext {
  task: string;
  mode: ValidMode;
  project?: string;
  model?: string;
  modelTier?: string;
  orchestrator?: string;
  executionProfile?: string;
  projectRoot?: string;
  /** VCS: Locked anchor directory (human-visible context lock line). */
  anchorPath?: string;
  /** VCS: Human-readable permission preset label. */
  preset?: 'read-only' | 'ask' | 'auto';
}

const PRESET_LABELS: Record<NonNullable<TextRunPreludeContext['preset']>, string> = {
  'read-only': 'Read-only audit & proposal',
  ask: 'Supervised (ask before each write)',
  auto: 'Autonomous (writes permitted)',
};

function shouldShowPlanModeWarning(mode: ValidMode): boolean {
  return mode === 'plan' || readRuntimeMode() === 'plan';
}

export function renderTextRunPrelude(context: TextRunPreludeContext): string {
  const blocks = [
    renderRunPrelude({
      task: context.task,
      mode: context.mode,
      project: context.project,
      model: context.model,
      tier: context.modelTier,
      router: context.orchestrator ?? 'v9',
      executionProfile: context.executionProfile ?? 'safe_repo',
      runDir: '(pending)',
      showStatus: true,
    }),
  ];

  // VCS: show context lock line when anchorPath is resolved
  if (context.anchorPath) {
    blocks.push(`Context Locked: ${context.anchorPath}`);
  }

  // VCS: show human-readable mode instead of internal lane ID
  if (context.preset) {
    blocks.push(`Mode: ${PRESET_LABELS[context.preset]}`);
  }

  if (shouldShowPlanModeWarning(context.mode)) {
    blocks.push('', renderPlanModeWarning());
  }
  return `${blocks.join('\n')}\n`;
}

export function writeTextRunPrelude(
  context: TextRunPreludeContext,
  stream: NodeJS.WriteStream = process.stdout,
): void {
  printBanner();
  stream.write(renderTextRunPrelude(context));
}
