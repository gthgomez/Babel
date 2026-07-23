import {
  accentBright,
  activeAccent,
  border,
  muted,
  primary,
  dim,
  bold,
  commandAccent,
  info,
  sectionLabel,
  success,
  error,
  warning,
  getTerminalWidth,
  getEffectiveTerminalWidth,
  padRight,
  hyperlinkFile,
  visibleLength,
  wrapText,
  stripAnsi,
  truncate,
} from './theme.js';
import { globalCostTracker } from '../services/costTracker.js';
import { InputCoordinator } from './inputCoordinator.js';
import { renderMarkdown, clearMdRenderCache } from './highlight.js';
import { RawModeManager } from './rawMode.js';
import { KeybindingManager } from './keybindings.js';
import { FrameScheduler } from './frameScheduler.js';
import { MarkdownAccumulator } from './markdownAccumulator.js';
import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';
import { renderBackgroundTaskOverlay } from './backgroundTaskOverlay.js';
import { ScrollbackBuffer } from './scrollback.js';
import { ScreenManager } from './screenManager.js';
import { OutputBuffer, isBrokenStdoutError } from './outputBuffer.js';
import { isA11yMode, a11yStageEvent, a11yActivityEvent, a11yToolEvent } from './a11y.js';
import { ChunkCoalescer } from './chunkCoalescer.js';
import { TwoRegionStreaming } from './twoRegionStreaming.js';
import { AgentStreamManager, type AgentStreamEvent } from './agentProgress.js';
import { getMotionMode, MotionMode, shimmerText } from './motion.js';
import { renderUnseenDividerPill } from './unseenDivider.js';
import {
  StateStore,
  createTuiStore,
  type TuiMutation,
  type TuiState,
  createInitialTuiState,
} from './stateMutationBus.js';
import { HistoryCellViewport, HistoryTranscript } from './historyCells/index.js';
import type { HistoryCellRecord } from './historyCells/types.js';

const SPINNER_FRAMES: readonly string[] = ['◐', '◓', '◑', '◒'];
const STALL_THRESHOLD_MS = 3000; // fade indicator toward red after 3s idle
const FRAME_INTERVAL_MS = 200; // 5 FPS spinner tick

/**
 * Write text to the unified OutputBuffer, checking for broken pipes.
 * When the OutputBuffer has detected a broken stdout (EPIPE etc.), the
 * write is silently swallowed and `false` is returned so callers can
 * abort streaming loops.
 *
 * Wraps output in DEC 2026 synchronized update frames when the terminal
 * supports it to prevent visual tearing. When already inside a frame
 * (e.g., from a render() method), the frame is silently merged into the
 * outer frame by OutputBuffer.
 */
function safeStdoutWrite(text: string): boolean {
  const buf = OutputBuffer.getInstance();
  if (!buf.canWrite) return false;
  const openedFrame = !buf.inFrame && buf.syncUpdateSupported;
  if (openedFrame) buf.beginFrame();
  try {
    buf.write(text);
  } finally {
    if (openedFrame) buf.endFrame();
  }
  return true;
}

function installStdoutErrorGuard(onBrokenPipe: () => void): () => void {
  const handler = (error: Error) => {
    if (isBrokenStdoutError(error)) {
      onBrokenPipe();
      return;
    }
    throw error;
  };
  process.stdout.on('error', handler);
  return () => {
    process.stdout.off('error', handler);
  };
}

let activeRendererInstance: BaseRenderer | null = null;

export function getActiveRenderer(): BaseRenderer | null {
  return activeRendererInstance;
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface EventBus {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

interface RendererContext {
  mode?: string | undefined;
  task?: string | undefined;
  targetProject?: string | undefined;
  project?: string | undefined;
  projectRoot?: string | undefined;
}

interface RuntimeEvent {
  event_type?: string;
  payload?: {
    tool?: string;
    target?: string;
    command?: string;
    exit_code?: number;
    detail?: string;
    decision?: string;
    status?: string;
  };
}

interface SummaryOptions {
  status?: string | undefined;
  costUSD?: number | undefined;
  changedFiles?: unknown;
  perRunCost?: number | undefined;
}

/**
 * Base renderer providing shared EPIPE guard, output-broken flag, and
 * active-instance tracking. All concrete renderers extend this.
 */
class BaseRenderer {
  protected outputBroken: boolean;
  private removeStdoutErrorGuard: (() => void) | undefined;
  protected _onBrokenPipe: () => void;

  constructor() {
    activeRendererInstance = this;
    this.outputBroken = false;
    this._onBrokenPipe = () => {}; // no-op, overridden by subclasses
    this.removeStdoutErrorGuard = installStdoutErrorGuard(() => {
      this.outputBroken = true;
      this._onBrokenPipe?.();
    });
  }

  get canWrite(): boolean {
    return !this.outputBroken;
  }

  /** Shared pause/resume for JIT prompts. */
  pauseTicks(): void {
    this._pausedTicks = true;
  }
  resumeTicks(): void {
    this._pausedTicks = false;
  }

  destroy(): void {
    this.removeStdoutErrorGuard?.();
  }

  // note: the _pausedTicks field below is read by overrides in subclasses
  // that use a differently-named `pausedTicks` (no underscore). This base
  // declaration preserves the original JS shape exactly.
  protected _pausedTicks: boolean | undefined = undefined;
}

/**
 * Professional live HUD for governed pipeline execution.
 * Manages a reactive coding-agent view with stage progress and activity log.
 */
export class WaterfallRenderer extends BaseRenderer {
  private context: RendererContext;
  private onResize: () => void;
  private transcriptLines: string[];
  private startTime: number;
  private stageStartTimes: number[];
  private stageDurations: number[];
  private lastMeaningfulEventAt: number;
  private waitingLineAdded: boolean;
  private thinking: boolean;
  private thinkingFrame: number;
  private activityKeys: Set<string>;
  private paused: boolean;
  protected pausedTicks: boolean;
  private frames: string[];
  private finalSnapshot: string;
  private lastCostUpdateTime: number;
  private lastCancelTime: number | undefined;
  private _unregisterFrameScheduler: (() => void) | undefined;
  private _unregisterOutputResize: (() => void) | undefined;
  private readonly _rawMode: RawModeManager;
  private _store: StateStore<TuiState, TuiMutation>;
  private readonly _eventBus: EventBus;
  private _eventBusHandles: Array<{ event: string; listener: (...args: any[]) => void }> = [];

  constructor(eventBus: EventBus, context: RendererContext = {}) {
    super();
    this._eventBus = eventBus;

    // Override EPIPE cleanup to stop the frame scheduler
    this._onBrokenPipe = () => {
      FrameScheduler.getInstance().setComponentPermanentDirty('waterfall-hud', false);
    };

    this.context = context;
    this.onResize = () => {
      this._handleHudResize();
    };
    process.stdout.on('resize', this.onResize);
    this._unregisterOutputResize = OutputBuffer.getInstance().onResize(() => {
      this._handleHudResize();
    });
    this.transcriptLines = [];
    this.startTime = Date.now();
    this.stageStartTimes = [0, this.startTime, 0, 0, 0]; // index 1-4 for 4 stages
    this.stageDurations = [0, 0, 0, 0, 0]; // accumulated stage durations
    this.lastMeaningfulEventAt = this.startTime;
    this.waitingLineAdded = false;
    this.thinking = false;
    this.thinkingFrame = 0;
    this.activityKeys = new Set();
    this.paused = false;
    this.pausedTicks = false;
    this.frames = ['◐', '◓', '◑', '◒'];
    this.finalSnapshot = '';
    this.lastCostUpdateTime = 0;
    this.lastCancelTime = undefined;
    this._unregisterFrameScheduler = undefined;
    this._rawMode = new RawModeManager(process.stdin, { manageCursor: true });
    this._store = createTuiStore();
    // Initialize store's lastActivityTime and initial stage/action to match renderer start
    const initState = createInitialTuiState();
    initState.lastActivityTime = this.startTime;
    initState.stage = 1; // Start at analyzing (orchestrator), not 0
    initState.activeAction = 'Starting Babel';
    this._store.setState(initState);

    const onAssistantThought = (thought: string) => {
      if (this.paused) return;
      this._store.dispatch({ type: 'thought:chunk', text: thought });
      FrameScheduler.getInstance().markComponentDirty('waterfall-hud');
    };
    eventBus.on('assistant_thought', onAssistantThought);
    this._eventBusHandles.push({ event: 'assistant_thought', listener: onAssistantThought });

    const onStage = (index: number) => {
      if (this.paused) return;
      const s = this._store.currentState;
      // Record previous stage duration before transitioning
      if (s.stage > 0 && (this.stageStartTimes[s.stage] ?? 0) > 0) {
        const prevDuration = Date.now() - (this.stageStartTimes[s.stage] ?? 0);
        this.stageDurations = this.stageDurations || [];
        this.stageDurations[s.stage] = prevDuration;
      }
      this._store.dispatch({ type: 'stage:transition', stage: index });
      this.stageStartTimes[index] = Date.now();
      this.thinking = false;
      this.recordActivity(stageAction(index));
      const stats = globalCostTracker.getSessionSummary();
      this._store.dispatch({ type: 'cost:update', costUSD: stats.totalCostUSD });
      this.lastCostUpdateTime = Date.now();
      FrameScheduler.getInstance().markComponentDirty('waterfall-hud');
      if (isA11yMode()) {
        a11yStageEvent(index, stageAction(index));
      }
    };
    eventBus.on('stage', onStage);
    this._eventBusHandles.push({ event: 'stage', listener: onStage });

    const onAgentId = (id: string) => {
      if (this.paused) return;
      this._store.dispatch({ type: 'agent:id', id });
      FrameScheduler.getInstance().markComponentDirty('waterfall-hud');
    };
    eventBus.on('agent_id', onAgentId);
    this._eventBusHandles.push({ event: 'agent_id', listener: onAgentId });

    const onLog = (line: string) => {
      if (this.paused) return;
      // Capture plan step count from action-step lines before normalization
      const stepMatch = String(line ?? '').match(/Action steps?:\s*(\d+)/i);
      if (stepMatch?.[1]) {
        this._store.dispatch({ type: 'planStep:count', planStepCount: parseInt(stepMatch[1], 10) });
      }
      const normalized = normalizeActivityLine(line);
      if (!normalized) {
        return;
      }
      if (/thinking|planning|reasoning/i.test(normalized)) {
        this.thinking = true;
      }
      const fileMatch = normalized.match(
        /\b(?:reading|writing|editing|patched|file)\b[:\s]+([^\s]+)/i,
      );
      if (fileMatch?.[1]) {
        const file = fileMatch[1].replace(/["']/g, '');
        this._store.dispatch({ type: 'file:changed', filePath: file, additions: 0, deletions: 0 });
      }
      this.recordActivity(normalized);
      FrameScheduler.getInstance().markComponentDirty('waterfall-hud');
    };
    eventBus.on('log', onLog);
    this._eventBusHandles.push({ event: 'log', listener: onLog });

    const onRuntimeEvent = (event: RuntimeEvent) => {
      if (this.paused) return;
      const label = runtimeEventLabel(event);
      if (label) {
        this.recordActivity(label);
      }
      if (event?.event_type === 'tool.completed') {
        this._store.dispatch({ type: 'tools:increment' });
        const stats = globalCostTracker.getSessionSummary();
        this._store.dispatch({ type: 'cost:update', costUSD: stats.totalCostUSD });
        this.lastCostUpdateTime = Date.now();
      }
      if (event?.event_type === 'verification.decision') {
        const newStage = Math.max(this._store.currentState.stage, 4);
        this._store.dispatch({ type: 'stage:transition', stage: newStage });
      }
      FrameScheduler.getInstance().markComponentDirty('waterfall-hud');
    };
    eventBus.on('runtime_event', onRuntimeEvent);
    this._eventBusHandles.push({ event: 'runtime_event', listener: onRuntimeEvent });

    // Register with the unified FrameScheduler — per-component scheduling
    // with independent interval and dirty tracking.
    const scheduler = FrameScheduler.getInstance();
    this._unregisterFrameScheduler = scheduler.scheduleComponent(
      'waterfall-hud',
      () => {
        if (this.paused || this.pausedTicks) return;
        this.thinkingFrame = (this.thinkingFrame + 1) % this.frames.length;
        this.updateWaitingState();
        this.render();
      },
      { intervalMs: 50, priority: 10, label: 'waterfall-hud' },
    );
    scheduler.setComponentPermanentDirty('waterfall-hud', true);

    const onPromptPause = (label: string) => this.pauseForPrompt(label);
    eventBus.on('prompt_pause', onPromptPause);
    this._eventBusHandles.push({ event: 'prompt_pause', listener: onPromptPause });

    const onPromptResume = () => this.resume();
    eventBus.on('prompt_resume', onPromptResume);
    this._eventBusHandles.push({ event: 'prompt_resume', listener: onPromptResume });
  }

  enableRawMode(): void {
    if (this._rawMode.isActive) return;
    this._rawMode.enable((event) => {
      const action = KeybindingManager.getInstance().matchStack(['governed'], event);

      switch (action) {
        case 'dismiss_error':
          if (this._store.currentState.renderState === 'failed') this.stop();
          break;
        case 'cancel':
          this.fail(new Error('Run cancelled (Esc).'));
          break;
        case 'suspend':
          process.kill(process.pid, 'SIGTSTP');
          return;
        case 'cancel_double': {
          // Double-tap timing logic stays inline (stateful)
          const now = Date.now();
          if (this.lastCancelTime && now - this.lastCancelTime < 1000) {
            this.stop();
            process.exit(130);
          }
          this.lastCancelTime = now;
          this.fail(new Error('Run cancelled (Ctrl+C). Double-press to exit.'));
          break;
        }
        case 'thought_toggle': {
          const s = this._store.currentState;
          this._store.dispatch({ type: 'thought:toggle', collapsed: !s.thoughtCollapsed });
          this.render();
          break;
        }
        case 'pause_toggle':
          if (this.paused) {
            this._store.dispatch({
              type: 'action:update',
              action: stageAction(this._store.currentState.stage),
            });
            this.resume();
          } else {
            this._store.dispatch({ type: 'action:update', action: '⏸ Paused' });
            this.paused = true;
            this._store.dispatch({ type: 'pause:toggle', paused: true });
            this.pauseTicks();
            this._redrawPauseOverlay();
          }
          break;
        default:
          break;
      }
    });
  }

  disableRawMode(): void {
    this._rawMode.disable();
  }

  start(): void {
    this.enableRawMode();
    this.render();
  }

  /** Reflow governed HUD on terminal resize (stdout + OutputBuffer paths). */
  private _handleHudResize(): void {
    if (this.paused) {
      this._redrawPauseOverlay();
      return;
    }
    if (!this.pausedTicks) {
      FrameScheduler.getInstance().markComponentDirty('waterfall-hud');
    }
  }

  private _redrawPauseOverlay(): void {
    const width = getTerminalWidth();
    const pauseHud = [
      border('─'.repeat(width)),
      '  ' + activeAccent('⏸ Paused'),
      border('─'.repeat(width)),
      dim('  [P] resume  [T] thought  [Esc] cancel'),
    ].join('\n');
    const pauseBuf = OutputBuffer.getInstance();
    const pauseSync = OutputBuffer.supportsSyncUpdate();
    if (pauseSync) pauseBuf.beginFrame();
    try {
      pauseBuf.write(pauseHud + '\x1b[J');
    } finally {
      if (pauseSync) pauseBuf.endFrame();
    }
  }

  stop(): void {
    this.disableRawMode();
    FrameScheduler.getInstance().setComponentPermanentDirty('waterfall-hud', false);
    this._unregisterFrameScheduler?.();
    this._unregisterOutputResize?.();
    this._unregisterOutputResize = undefined;
    process.stdout.off('resize', this.onResize);
    // Unregister all event bus listeners to prevent leaks across create/stop cycles
    for (const handle of this._eventBusHandles) {
      this._eventBus.off(handle.event, handle.listener);
    }
    this._eventBusHandles = [];
    this.finalSnapshot = this.snapshot();
    if (this.finalSnapshot) {
      safeStdoutWrite('\r\n' + this.finalSnapshot + '\n');
    }
    safeStdoutWrite('[?25h');
    this.destroy();
  }

  fail(error?: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    const stage = this._store.currentState.stage;
    this._store.dispatch({ type: 'error', message, stage });
    this.render();
    setTimeout(() => {
      this.stop();
    }, 2000);
  }

  pauseForPrompt(label: string = 'Waiting for user input'): void {
    this.paused = true;
    this._store.dispatch({ type: 'pause:toggle', paused: true });
    this.recordActivity(String(label));
    this.disableRawMode();
    safeStdoutWrite('[?25h');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false; // Tier 2 — kept as event handler guard until full store migration
    this._store.dispatch({ type: 'pause:toggle', paused: false });
    this.enableRawMode();
    safeStdoutWrite('[?25l');
    this.render();
  }

  override pauseTicks(): void {
    this.pausedTicks = true;
    // Disable HUD updates in the frame scheduler while paused
    FrameScheduler.getInstance().setComponentPermanentDirty('waterfall-hud', false);
    // Clear the HUD area from the terminal
    OutputBuffer.getInstance().write('\x1b[H\x1b[J');
  }

  override resumeTicks(): void {
    this.pausedTicks = false;
    // Re-enable HUD updates in the frame scheduler
    FrameScheduler.getInstance().setComponentPermanentDirty('waterfall-hud', true);
    this.render();
  }

  recordActivity(line: string): void {
    const key = activityKey(line);
    if (!line || this.activityKeys.has(key)) {
      return;
    }
    this.activityKeys.add(key);
    this.lastMeaningfulEventAt = Date.now();
    this.transcriptLines.push(
      `[${formatElapsed(this.lastMeaningfulEventAt - this.startTime)}] ${line}`,
    );
    this.waitingLineAdded = false;
    this._store.dispatch({ type: 'activity:log', line });
  }

  updateWaitingState(): void {
    const s = this._store.currentState;
    const idleMs = Date.now() - this.lastMeaningfulEventAt;
    // Progressive disclosure: subtle pulse at 5s, explicit status at 15s
    if (idleMs < 5_000) {
      return;
    }
    if (idleMs >= 5_000 && idleMs < 15_000) {
      // Subtle pulse — update the active action to show we're still alive
      if (!s.activeAction.endsWith('…')) {
        this._store.dispatch({ type: 'action:update', action: s.activeAction + '…' });
      }
      return;
    }
    if (idleMs >= 15_000) {
      const waiting = s.stage >= 4 ? 'Waiting for command output' : 'Thinking…';
      if (s.activeAction !== waiting) {
        // Only add to activity log once to avoid duplicates
        if (!this.waitingLineAdded) {
          this.waitingLineAdded = true;
          this._store.dispatch({ type: 'activity:log', line: waiting });
        }
        this._store.dispatch({ type: 'action:update', action: waiting });
      }
    }
  }

  /** Get the transcript of activity lines. */
  getTranscript(): string {
    return this.transcriptLines.join('\n');
  }

  snapshot(): string {
    const s = this._store.currentState;
    const elapsed = formatElapsed(Date.now() - this.startTime);
    const stageLabels = ['Analyze', 'Plan', 'Review', 'Apply'];
    const stageSummary = stageLabels
      .map((label, i) => {
        const idx = i + 1;
        if (idx < s.stage) return `${successLike('●')} ${label}`;
        if (idx === s.stage) return `${activeAccent('◐')} ${label}`;
        return `${dim('○')} ${label}`;
      })
      .join('  ');

    const lines: string[] = [
      sectionLabel('── Run Complete ──'),
      `${muted('Duration')} ${elapsed}  ${muted('Cost')} ${commandAccent('$' + s.cachedCostStr)}  ${muted('Tools')} ${String(s.completedToolCalls)}`,
      '',
      sectionLabel('Stages:'),
      `  ${stageSummary}`,
    ];

    if (s.activityLog.length > 0) {
      lines.push('');
      lines.push(sectionLabel(`Activity (${s.activityLog.length}):`));
      lines.push(...s.activityLog.slice(-5).map((line) => `  ${activityColor(line)}`));
    }

    if (s.activeFiles.length > 0) {
      lines.push('');
      lines.push(sectionLabel('Files touched:'));
      lines.push(
        `  ${s.activeFiles.map((f) => hyperlinkFile(f, info(String(f ?? '')))).join(muted(', '))}`,
      );
    }

    if (s.thoughtText && !s.thoughtCollapsed) {
      const thoughtLines = renderMarkdown(s.thoughtText).trim().split('\n');
      const maxLines = 12;
      lines.push('');
      lines.push(sectionLabel('Thinking:'));
      if (thoughtLines.length > maxLines) {
        lines.push(dim(`  … (${thoughtLines.length - maxLines} more lines)`));
      }
      lines.push(...thoughtLines.slice(-maxLines).map((line) => `  ${dim(line)}`));
    }

    return lines.join('\n');
  }

  getFinalSnapshot(): string {
    return this.finalSnapshot ?? '';
  }

  /** Compute ETA based on completed stage durations.
   *  @param currentStage - the current pipeline stage (reads from store) */
  computeETA(currentStage: number): string | null {
    // Stage-level ETA: use average of completed stage durations
    const completed = this.stageDurations.filter((d, i) => i > 0 && d > 0 && i < currentStage);
    if (completed.length > 0 && currentStage < 4) {
      const avgDuration = completed.reduce((a, b) => a + b, 0) / completed.length;
      const remainingStages = 4 - currentStage + 1; // +1 for current stage
      const eta = Math.round(avgDuration * remainingStages);
      return formatETA(eta);
    }
    return null;
  }

  render(): void {
    const s = this._store.currentState;
    if (s.renderState !== 'failed' && (s.paused || this.pausedTicks)) return;
    if (this.outputBroken) return;

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      // Note: do NOT check InputCoordinator lock here — timer, stage dots, and
      // activity log should always update regardless of who owns the input lock.
      const effectiveWidth = getEffectiveTerminalWidth();
      const width = effectiveWidth;
      const elapsed = formatElapsed(Date.now() - this.startTime);
      if (!this.lastCostUpdateTime) this.lastCostUpdateTime = Date.now();
      if (Date.now() - this.lastCostUpdateTime > 30000) {
        const stats = globalCostTracker.getSessionSummary();
        this._store.dispatch({ type: 'cost:update', costUSD: stats.totalCostUSD });
        this.lastCostUpdateTime = Date.now();
      }

      // ── Failure state overlay ──────────────────────────────────────────
      if (s.renderState === 'failed') {
        const stageLabels = ['Analyze', 'Plan', 'Review', 'Apply'];
        const failedLabel = stageLabels[s.failedStage - 1] ?? 'Unknown';
        const progress = stageLabels
          .map((label, i) => {
            const index = i + 1;
            if (index < s.failedStage) return successLike('● ' + label);
            if (index === s.failedStage) return error('✗ ' + label);
            return dim('○ ' + label);
          })
          .join(muted('   '));

        const hud = [
          sectionLabel(
            `Mode: ${accentBright(this.context.mode ?? 'chat')}  Status: ${error('failed')}`,
          ),
          border('─'.repeat(width)),
          progress,
          `  ${error('Run failed — press Enter to dismiss')}`,
          '',
          sectionLabel('Error:'),
          `  ${error(s.errorMessage)}`,
          '',
          `${muted('Time')} ${elapsed}   ${muted('Cost')} ${commandAccent(`$${s.cachedCostStr}`)}`,
          border('─'.repeat(width)),
          dim('  [Enter] dismiss  [/inspect] details'),
        ].join('\n');

        buf.write(hud + '\x1b[J');
        if (!buf.canWrite) {
          this.outputBroken = true;
        }
        return;
      }
      // ── End failure state ──────────────────────────────────────────────

      const stageLabels = ['Analyze', 'Plan', 'Review', 'Apply'];
      const progress = stageLabels
        .map((label, i) => {
          const index = i + 1;
          if (index < s.stage) return successLike('● ' + label);
          if (index === s.stage) {
            const frame = this.frames[this.thinkingFrame] ?? '◐';
            const prefix = this.thinking ? activeAccent(frame) : activeAccent('◐');
            return bold(`${prefix} ${activeAccent(label)}`);
          }
          return dim('○ ' + label);
        })
        .join(muted('   '));

      const statusText = s.stage >= 4 ? 'done' : 'working';
      const modeText = this.context.mode ?? 'chat';
      const titleParts = [
        `Mode: ${accentBright(modeText)}`,
        `Status: ${statusText === 'done' ? success('done') : primary(statusText)}`,
      ];

      const progressDetail =
        s.planStepCount > 0
          ? (() => {
              const base = `Stage ${s.stage}/4  ·  Step ${Math.min(s.completedToolCalls + 1, s.planStepCount)} of ${s.planStepCount}`;
              if (s.completedToolCalls > 0) {
                const elapsedMs = Date.now() - this.startTime;
                const perTool = elapsedMs / s.completedToolCalls;
                const remaining = s.planStepCount - s.completedToolCalls;
                const toolEta = formatETA(perTool * remaining);
                if (toolEta) return `${base}  ·  ETA: ${toolEta}`;
              }
              return base;
            })()
          : s.stage > 1
            ? `Stage ${s.stage}/4  ·  ${stageLabels
                .map((label, i) => {
                  const idx = i + 1;
                  if (idx > s.stage) return null;
                  const duration =
                    idx === s.stage
                      ? Date.now() - (this.stageStartTimes[idx] ?? 0)
                      : this.stageDurations[idx];
                  if (!duration || duration < 1000) return null;
                  return `${label}: ${formatDuration(duration)}`;
                })
                .filter(Boolean)
                .join('  ·  ')}`
            : `Stage ${s.stage}/4`;
      const progressBar =
        s.planStepCount > 0
          ? (() => {
              const pct = Math.min(1, s.completedToolCalls / s.planStepCount);
              const barW = Math.max(10, width - 24);
              const filled = Math.floor(pct * barW);
              return accentBright('█'.repeat(filled)) + dim('░'.repeat(barW - filled));
            })()
          : null;

      // ETA estimation
      const eta = this.computeETA(s.stage);
      const etaText = eta ? `ETA: ${eta}` : '';

      const hud = [
        sectionLabel(titleParts.join('  ')),
        border('─'.repeat(width)),
        progress,
        `  ${muted(progressDetail)}${etaText ? dim('  ·  ') + accentBright(etaText) : ''}`,
        ...(progressBar ? [`  ${progressBar}`] : []),
        ...(s.activeAction || s.activityLog.length > 0
          ? [
              '',
              sectionLabel('Activity:'),
              // Current action first with primary styling
              ...(s.activeAction
                ? [`  ${primary('→')} ${primary(s.activeAction.slice(0, width - 6))}`]
                : []),
              // Historical entries (last 9, to keep total <= 10)
              ...s.activityLog
                .slice(s.activeAction ? -9 : -10)
                .map((line) => `  ${activityColor(truncate(stripAnsi(line), Math.max(1, width - 4)))}`),
            ]
          : []),
        ...(s.activeFiles.length > 0
          ? [
              '',
              sectionLabel('Files:'),
              `  ${s.activeFiles
                .map((f) => {
                  const display = String(f ?? '');
                  const truncated = display.length > 50 ? display.slice(0, 48) + '…' : display;
                  return hyperlinkFile(f, info(truncated));
                })
                .join(muted(', '))}`,
            ]
          : []),
        ...(s.thoughtText
          ? [
              '',
              s.thoughtCollapsed
                ? `${sectionLabel('Thinking Process:')} ${dim('(Collapsed. Press [T] to expand)')}`
                : sectionLabel('Thinking Process (Press [T] to collapse):'),
              ...(s.thoughtCollapsed
                ? []
                : renderMarkdown(s.thoughtText)
                    .trim()
                    .split('\n')
                    .slice(-4)
                    .map((line) =>
                      `  ${dim(truncate(stripAnsi(line), Math.max(1, width - 4)))}`,
                    )),
            ]
          : []),
        '',
        `${muted('Time')} ${elapsed}   ${muted('Cost')} ${commandAccent(`$${s.cachedCostStr}`)}`,
        border('─'.repeat(width)),
        dim('  [T] thought  [P] pause  [Esc] cancel  [Ctrl+R] history'),
      ].join('\n');

      buf.write(hud + '\x1b[J');
      if (!buf.canWrite) {
        this.outputBroken = true;
        FrameScheduler.getInstance().setComponentPermanentDirty('waterfall-hud', false);
      }
    } finally {
      if (useSync) buf.endFrame();
    }
  }
}

// ── Free helper functions ────────────────────────────────────────────────────

export function successLike(text: string): string {
  return accentBright(text);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatETA(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `~${minutes}m ${seconds}s`;
}

export function stageAction(index: number): string {
  if (index === 1) return 'Analyzing your request';
  if (index === 2) return 'Planning';
  if (index === 3) return 'Reviewing';
  if (index === 4) return 'Applying changes';
  return 'Working';
}

/**
 * Render a styled error box for display in the conversational renderer.
 *
 * Detects error type from the message and error object to show relevant
 * context: exit codes for tool failures, retry hints for API errors,
 * and a dismiss hint for all errors.
 */
export function renderErrorBox(
  message: string,
  err?: unknown,
  width: number = 80,
): string[] {
  const boxWidth = Math.min(width, 78);
  const top = `┌${'─'.repeat(boxWidth - 2)}┐`;
  const bottom = `└${'─'.repeat(boxWidth - 2)}┘`;

  const lines: string[] = [top];

  // Header
  lines.push(`│ ${error('✖ Error')}${' '.repeat(boxWidth - 11)}│`);

  // Message (word-wrapped to fit using visible-length-aware wrapping)
  const wrappedLines = wrapText(message, boxWidth - 4);
  for (const wrappedLine of wrappedLines) {
    const pad = boxWidth - 5 - visibleLength(wrappedLine);
    lines.push(`│ ${dim('│')} ${wrappedLine}${' '.repeat(pad)}│`);
  }

  // Context-sensitive details
  const errObj = (err as Record<string, unknown> | undefined) ?? undefined;

  // Tool call failure: show exit code + stderr hint
  if (errObj?.exitCode !== undefined || /exit code|command failed|shell.*fail/i.test(message)) {
    if (errObj?.exitCode !== undefined) {
      lines.push(`│ ${dim('Exit code:')} ${warning(String(errObj.exitCode))}${' '.repeat(boxWidth - 15 - String(errObj.exitCode).length)}│`);
    }
    if (errObj?.stderr) {
      const stderrSnippet = String(errObj.stderr).slice(0, 60);
      lines.push(`│ ${dim('stderr:')} ${stderrSnippet}${' '.repeat(Math.max(0, boxWidth - 10 - stderrSnippet.length))}│`);
    }
  }

  // API error: show retry hint
  if (
    /rate limit|429|5\d{2}|timeout|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(message)
  ) {
    lines.push(`│ ${dim('Tip:')} The API may be temporarily unavailable. ${dim('Try again in a moment.')}${' '.repeat(Math.max(0, boxWidth - 58))}│`);
  }

  // Dismiss hint
  lines.push(`│${' '.repeat(boxWidth - 2)}│`);
  lines.push(`│ ${dim('Press Enter to continue')}${' '.repeat(boxWidth - 25)}│`);
  lines.push(bottom);

  return lines;
}

export function activityKey(line: string): string {
  return String(line ?? '')
    .toLowerCase()
    .replace(/\d+\s*\/\s*\d+/g, '#/#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeActivityLine(line: string): string | null {
  const text = String(line ?? '').trim();
  if (!text) return null;
  if (text.includes('### INTERNAL MONOLOGUE')) return null;
  if (text.startsWith('{') || text.includes('"tool":') || /\{.*\}/.test(text)) return null;
  const cleaned = text
    .replace(/^\[babel:[^\]]+\]\s*/i, '')
    .replace(/^\[babel\]\s+\d{1,2}:\d{2}:\d{2}\s*/i, '')
    .replace(/^Executor\s+turn\s+\d+\s*\/\s*\d+\s*[:—-]?\s*/i, '')
    .replace(/^Stage\s+\d+\s*\/\s*\d+\s*[—-]\s*/i, '')
    .replace(
      /\[(?:EXECUTOR_HALTED|QA_REJECTED_MAX_LOOPS|FATAL_ERROR|SHELL_COMMAND_FAILED|VERIFIER_FAILED|ROLLBACK_FAILED|ROLLBACK_APPLIED|WORKTREE_DIRTY_UNSAFE)\]/gi,
      '',
    )
    .replace(/\[debug\]\s*/i, '')
    .replace(/—/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, Math.max(60, getTerminalWidth() - 8));
  // Stage messages (match both old and new pipeline stage text)
  if (
    /^Stage\s+1\s*\/\s*(?:4|3)/i.test(text) ||
    /^Analyzing/i.test(cleaned) ||
    /^Orchestrator\b/i.test(cleaned)
  )
    return 'Analyzing request';
  if (
    /^Stage\s+2\s*\/\s*(?:4|3)/i.test(text) ||
    /^Planning/i.test(cleaned) ||
    /^SWE Agent\b/i.test(cleaned)
  )
    return 'Planning';
  if (
    /^Stage\s+3\s*\/\s*(?:4|3)/i.test(text) ||
    /^Reviewing/i.test(cleaned) ||
    /^QA Reviewer\b/i.test(cleaned)
  )
    return 'Reviewing';
  if (
    /^Stage\s+4\s*\/\s*(?:4|3)/i.test(text) ||
    /^Applying/i.test(cleaned) ||
    /^CLI Executor\b/i.test(cleaned) ||
    /^Executor\b/i.test(text)
  )
    return 'Applying changes';
  if (/^Stage\s+0\s*\/\s*(?:4|3)/i.test(text) || /^Optimizing context/i.test(cleaned))
    return 'Optimizing context';
  // Pipeline lifecycle messages
  if (/^Run directory:/i.test(cleaned)) return null; // internal, not user-facing
  if (/^DRY RUN mode active|Dry run mode is on/i.test(cleaned)) return 'Dry run active';
  if (/^Execution profile:/i.test(cleaned))
    return `Using ${cleaned.replace(/^Execution profile:\s*/i, '')} profile`;
  if (/^Resolved typed stack/i.test(cleaned)) return 'Loaded project context';
  // Hide internal telemetry and config
  if (/^v9 stack telemetry:/i.test(cleaned)) return null;
  if (/^Tool project root:/i.test(cleaned)) return null;
  if (/^Project:/i.test(cleaned)) return null;
  if (/^Model:/i.test(cleaned)) return null;
  if (/^Provider:/i.test(cleaned)) return null;
  if (/^Router:/i.test(cleaned)) return null;
  if (
    /model_context|provider|prompt_manifest|instruction_stack|selected_entry_ids|provider_model_id|assigned_model|model_adapter|prompt-stack|prompt stack|telemetry|BABEL_PROJECT_ROOT/i.test(
      cleaned,
    )
  )
    return null;
  if (/^Mode:/i.test(cleaned)) return null;
  if (/^Pipeline mode/i.test(cleaned)) return null;
  if (/^Session start/i.test(cleaned)) return null;
  if (/^Authoritative project root/i.test(cleaned)) return null;
  if (/^Runtime project root/i.test(cleaned)) return null;
  // Plan and result messages
  if (/^Action steps:/i.test(cleaned)) return 'Plan ready';
  if (/^Mode is "chat"/i.test(cleaned)) return 'Complete — read-only';
  if (/^Pipeline complete|^Done — /i.test(cleaned)) return 'Complete';
  if (/^QA:\s*PASS/i.test(cleaned)) return 'Review passed';
  if (/^QA:\s*(REJECT|FAIL)/i.test(cleaned)) return 'Review blocked';
  if (/QA.*PASS|review.*pass/i.test(cleaned)) return 'Review passed';
  if (/QA.*REJECT|QA.*FAIL|review.*reject|review.*blocked/i.test(cleaned)) return 'Review blocked';
  if (/Review cancelled|Pipeline halted|EXECUTOR_HALTED|Stopped — /i.test(cleaned))
    return 'Stopped';
  // Tool activity
  if (/directory_list|file_read|semantic_search|Reading/i.test(cleaned)) return 'Reading file';
  if (/file_write|patched|applying/i.test(cleaned)) return 'Writing file';
  if (/test_run|verifier|verification|npm test|pytest|gradle test/i.test(cleaned))
    return 'Running check';
  if (/^Run data:/i.test(cleaned)) return null; // internal
  if (/^See .* for details/i.test(cleaned)) return null;
  if (/^Run data saved/i.test(cleaned)) return null;
  if (/^Evidence bundle:/i.test(cleaned)) return null;
  return cleaned;
}

// Color-code activity lines by type for at-a-glance scanability
export function activityColor(line: string): string {
  const text = String(line ?? '');
  if (/error|fail|halt|block|denied|stopped|cancel/i.test(text)) return error(text);
  if (/writ|patched|applying/i.test(text)) return success(text);
  if (/ran |running |shell|command|npm |pytest|gradle/i.test(text)) return warning(text);
  if (/read|list|search|grep|glob|found/i.test(text)) return info(text);
  return muted(text);
}

export function runtimeEventLabel(event: RuntimeEvent): string | null {
  if (!event?.event_type) return null;
  if (event.event_type === 'session.started') return null;
  if (event.event_type === 'session.completed') return null;
  if (event.event_type === 'verification.decision') {
    const decision = event.payload?.decision ?? event.payload?.status;
    return decision ? `Verification ${String(decision).toLowerCase()}` : 'Verification recorded';
  }
  if (event.event_type === 'policy.decision') return 'Policy decision recorded';
  if (event.event_type === 'tool.requested') {
    const tool = String(event.payload?.tool ?? '');
    const target = event.payload?.target ? ` ${String(event.payload.target)}` : '';
    // Show actual tool name and target, not generic labels
    if (/directory_list|file_read|semantic_search/i.test(tool)) return `${tool}${target}`;
    if (/test_run|verifier/i.test(tool)) return `${tool}${target}`;
    if (/file_write/i.test(tool)) return `${tool}${target}`;
    if (/shell_exec/i.test(tool)) {
      const cmd = event.payload?.command ? `: ${String(event.payload.command).slice(0, 40)}` : '';
      return `${tool}${cmd}`;
    }
    return `${tool}${target}`;
  }
  if (event.event_type === 'tool.completed') {
    const tool = String(event.payload?.tool ?? '');
    const target = event.payload?.target ? ` ${String(event.payload.target)}` : '';
    const exitCode = event.payload?.exit_code;
    const detail = event.payload?.detail ? ` (${event.payload.detail})` : '';
    const status = exitCode === 0 ? '✓' : exitCode !== undefined ? `✗ (${exitCode})` : '';
    if (/directory_list|file_read|semantic_search/i.test(tool))
      return `${tool}${target} ${status}${detail}`;
    if (/test_run|verifier/i.test(tool)) return `${tool}${target} ${status}${detail}`;
    if (/file_write/i.test(tool)) return `${tool}${target} ${status}${detail}`;
    if (/shell_exec/i.test(tool)) return `${tool}${target} ${status}${detail}`;
    return `${tool}${target} ${status}${detail}`;
  }
  return null;
}

export class TtyHudRenderer extends WaterfallRenderer {}

export class AppendOnlyRenderer extends BaseRenderer {
  private context: RendererContext;
  private startTime: number;
  private lastMessage: string | null;
  private activityKeys: Set<string>;
  private transcriptLines: string[];
  private thoughtText: string;
  private readonly _eventBus: EventBus;
  private _eventBusHandles: Array<{ event: string; listener: (...args: any[]) => void }> = [];

  constructor(eventBus: EventBus, context: RendererContext = {}) {
    super();
    this._eventBus = eventBus;
    this.context = context;
    this.startTime = Date.now();
    this.lastMessage = null;
    this.activityKeys = new Set();
    this.transcriptLines = [];
    this.thoughtText = '';

    const onStage = (index: number) => this.write(stageAction(index));
    eventBus.on('stage', onStage);
    this._eventBusHandles.push({ event: 'stage', listener: onStage });

    const onLog = (line: string) => {
      const normalized = normalizeActivityLine(line);
      if (normalized) this.write(normalized);
    };
    eventBus.on('log', onLog);
    this._eventBusHandles.push({ event: 'log', listener: onLog });

    const onRuntimeEvent = (event: RuntimeEvent) => {
      const label = runtimeEventLabel(event);
      if (label) this.write(label);
    };
    eventBus.on('runtime_event', onRuntimeEvent);
    this._eventBusHandles.push({ event: 'runtime_event', listener: onRuntimeEvent });

    const onAssistantThought = (thought: string) => {
      this.thoughtText += thought;
    };
    eventBus.on('assistant_thought', onAssistantThought);
    this._eventBusHandles.push({ event: 'assistant_thought', listener: onAssistantThought });

    const onPromptPause = (label: string) =>
      this.write(String(label ?? 'Waiting for user input'));
    eventBus.on('prompt_pause', onPromptPause);
    this._eventBusHandles.push({ event: 'prompt_pause', listener: onPromptPause });

    const onPromptResume = () => this.write('Resuming work');
    eventBus.on('prompt_resume', onPromptResume);
    this._eventBusHandles.push({ event: 'prompt_resume', listener: onPromptResume });
  }

  start(): void {
    this.write(`Babel started: ${this.context.task ?? 'run'}`);
    if (this.context.targetProject || this.context.project) {
      this.write(`Target: ${this.context.targetProject ?? this.context.project}`);
    }
    if (this.context.projectRoot && this.context.projectRoot !== process.cwd()) {
      this.write(`Target root: ${this.context.projectRoot}`);
    }
  }

  stop(): void {
    // Unregister all event bus listeners to prevent leaks across create/stop cycles
    for (const handle of this._eventBusHandles) {
      this._eventBus.off(handle.event, handle.listener);
    }
    this._eventBusHandles = [];
    this.destroy();
  }

  fail(error?: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    this.write(`Babel failed: ${message}`);
    this.stop();
  }

  write(message: string): void {
    if (this.outputBroken) return;
    const key = activityKey(message);
    if (message === this.lastMessage || this.activityKeys.has(key)) return;
    this.lastMessage = message;
    this.activityKeys.add(key);
    const line = `[${formatElapsed(Date.now() - this.startTime)}] ${message}\n`;
    this.transcriptLines.push(line.trimEnd());
    if (!safeStdoutWrite(line)) {
      this.outputBroken = true;
    }
    if (isA11yMode()) {
      a11yActivityEvent(message);
    }
  }

  getTranscript(): string {
    return this.transcriptLines.join('\n');
  }

  pauseForPrompt(label: string = 'Waiting for user input'): void {
    this.write(String(label));
  }

  resume(): void {
    this.write('Resuming work');
  }
}

export class NoopRenderer extends BaseRenderer {
  constructor() {
    super();
  }
  start(): void {
    /* no-op */
  }
  stop(): void {
    this.destroy();
  }
  fail(_error?: unknown): void {
    /* no-op */
  }
  getTranscript(): string {
    return '';
  }
}

export function createLiveRunRenderer(
  eventBus: EventBus,
  context: RendererContext = {},
  stream: NodeJS.WriteStream = process.stdout,
  stateStore?: StateStore<TuiState, TuiMutation> | undefined,
): AppendOnlyRenderer | ConversationalRenderer {
  if (!stream?.isTTY) {
    return new AppendOnlyRenderer(eventBus, context);
  }
  if (process.env.NO_COLOR || process.env.CI || isA11yMode()) {
    return new AppendOnlyRenderer(eventBus, context);
  }
  // ConversationalRenderer is the default for ALL modes on TTY
  return new ConversationalRenderer(stateStore ? { isTTY: true, stateStore } : { isTTY: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ConversationalRenderer — streaming chat TUI for Chat mode
// ═══════════════════════════════════════════════════════════════════════════════

export { conversationalToolLabel, TOOL_LABELS } from './toolDisplay.js';
import { conversationalToolLabel } from './toolDisplay.js';

/**
 * Conversational streaming renderer for Chat mode.
 *
 * Mimics Claude Code / Codex: natural language flows freely, tool calls appear
 * as brief transient indicators, and the final output reads like a conversation.
 */
export class ConversationalRenderer extends BaseRenderer {
  private isTTY: boolean | undefined;
  private answerChunks: string[];
  private toolCallIndex: number;
  private pendingToolCalls: Map<number, { tool: string; target: string }>;
  private startTime: number;
  private toolCallCount: number;
  private lastCancelTime: number | undefined;
  private thoughtText: string;
  private thoughtCollapsed: boolean;
  private paused: boolean;
  private _mdAccumulator: MarkdownAccumulator;
  private _chunkCoalescer: ChunkCoalescer;
  private _twoRegion: TwoRegionStreaming | null = null;
  /**
   * Mutable function reference for writing output chunks.
   *
   * Defaults to safeStdoutWrite for direct stdout output. When
   * TwoRegionStreaming hardware mode is active, this is swapped to
   * `(text) => this._twoRegion!.writeStreaming(text)` so streaming
   * content goes through the DECSTBM-scoped streaming region instead
   * of raw stdout.
   *
   * This indirection lets the ChunkCoalescer callback stay fixed while
   * the actual write path changes. Any refactoring of the ChunkCoalescer
   * callback must preserve this indirection — it is intentionally a
   * mutable function reference.
   */
  private _writeOutput: (text: string) => void = safeStdoutWrite;
  private _agentStreams: AgentStreamManager;
  private _cancelCallback: ((...args: unknown[]) => unknown) | null;
  private _state: string;
  private _lastActivityTime: number;
  private _spinnerFrame: number;
  private _unregisterTick: (() => void) | null;
  private _resizeHandler: (() => void) | null;
  /** Unregister function returned by OutputBuffer.onResize for the reflow callback. */
  private _unregisterResize: (() => void) | null;
  private _checkpointAvailable: boolean;
  /** Total overlay lines shown below the thinking line (bg tasks + subagents). */
  private _showingOverlayLines: number;
  /** Gap #4: Active subagents tracked during the thinking phase. */
  private _subAgents: Map<string, {
    label: string;
    startTime: number;
    status: 'running' | 'complete' | 'failed';
    tokens?: number;
    error?: string;
  }> = new Map();
  private _toolFrameIndex: number;
  private scrollback: ScrollbackBuffer | undefined;
  private screenManager: ScreenManager | undefined;
  private taskLabel: string | undefined;
  private readonly _rawMode: RawModeManager;

  private _pendingToolCallLines: number;
  private _store: StateStore<TuiState, TuiMutation> | undefined;

  /** Number of unseen lines that arrived while the user was scrolled up
   *  (conceptual scroll state for the conversational renderer). */
  private _unseenCount: number;
  /** Whether the user is conceptually scrolled above the latest content. */
  private _userScrolledUp: boolean;
  /** Inline approval overlay — shown while PermissionDialog is open. */
  private _approvalPending: { tool: string; target: string } | null = null;
  /** Phase B2: discrete history cells with active → committed flush lifecycle. */
  private _historyTranscript: HistoryTranscript;
  /** Phase B4: virtual scroll viewport over measured history cells. */
  private _cellViewport: HistoryCellViewport;

  /** Sync a subset of renderer instance fields from the StateStore.
   *  Fields synced: paused, thoughtCollapsed, thoughtText.
   *
   *  NOT synced (intentionally renderer-local):
   *   - _state (state machine owned by renderer; store follows via dispatch())
   *   - _lastActivityTime, answerChunks, toolCallIndex, pendingToolCalls
   *     (transient renderer-local state — see inline comment below) */
  private _syncFromStore(): void {
    if (!this._store) return;
    const s = this._store.currentState;
    this.paused = s.paused;
    this.thoughtCollapsed = s.thoughtCollapsed;
    this.thoughtText = s.thoughtText;
    // Note: _lastActivityTime, answerChunks, toolCallIndex, etc.
    // are renderer-local and intentionally NOT synced from store.
  }

  constructor(
    {
      isTTY,
      stateStore,
    }: {
      isTTY?: boolean;
      stateStore?: StateStore<TuiState, TuiMutation> | undefined;
    } = { isTTY: process.stdout.isTTY },
  ) {
    super();
    this._store = stateStore ?? createTuiStore();
    // Note: do NOT call setState — the store is already initialized with defaults
    // Only gate auto-detected TTY on CI — explicit {isTTY: true} from tests
    // or programmatic callers must be respected even in CI environments.
    this.isTTY = isTTY ?? (process.stdout.isTTY && !process.env['CI']);
    this.answerChunks = [];
    this.toolCallIndex = 0;
    this.pendingToolCalls = new Map();
    this.startTime = Date.now();
    this.toolCallCount = 0;
    this.lastCancelTime = undefined;
    this.thoughtText = '';
    this.thoughtCollapsed = false;
    this.paused = false;
    this._mdAccumulator = new MarkdownAccumulator();
    this._chunkCoalescer = new ChunkCoalescer(
      (batch: string) => {
        this._writeOutput(batch);
        // In two-region mode, the terminal's hardware scroll region handles
        // scrollback — we don't need to push lines manually.
        if (!this._twoRegion?.isHardwareMode) {
          this._pushLinesToScrollback(batch);
        }
      },
      16, // 16ms batch window (~60 FPS)
    );
    this._agentStreams = new AgentStreamManager();
    this._cancelCallback = null;
    this._state = 'idle';
    this._lastActivityTime = Date.now();
    this._spinnerFrame = 0;
    this._unregisterTick = null;
    this._resizeHandler = null;
    this._unregisterResize = null;
    this._checkpointAvailable = false;
    this._showingOverlayLines = 0;
    this._toolFrameIndex = 0;
    this._pendingToolCallLines = 0;
    this._unseenCount = 0;
    this._userScrolledUp = false;
    this._historyTranscript = new HistoryTranscript();
    this._cellViewport = new HistoryCellViewport(process.stdout.columns ?? 80);
    this.scrollback = undefined;
    this.screenManager = undefined;
    this.taskLabel = undefined;
    this._rawMode = new RawModeManager(process.stdin, { manageCursor: true });

    // Override EPIPE cleanup to stop frame scheduler and raw mode
    this._onBrokenPipe = () => {
      if (this._unregisterTick) {
        this._unregisterTick();
        this._unregisterTick = null;
      }
      FrameScheduler.getInstance().setComponentPermanentDirty('thinking-spinner', false);
      // forceCleanup restores raw mode and shows cursor (handles cursor
      // restoration automatically, but the explicit show below is kept
      // as a belt-and-suspenders safety net since this is an EPIPE path)
      this._rawMode.forceCleanup();
      safeStdoutWrite('\x1b[?25h'); // restore cursor
    };
  }

  /** Wire a host-provided cancel action (e.g. ChatEngine.cancel) so the Esc
   *  key aborts the in-flight LLM request, not just the renderer. */
  setCancelTarget(cb: (...args: unknown[]) => unknown): void {
    this._cancelCallback = cb;
  }

  /** Set whether session-level checkpoints exist, enabling the
   *  "[Ctrl+R] restore checkpoint" hint in the stop() footer. */
  setCheckpointAvailable(available: boolean): void {
    this._checkpointAvailable = !!available;
  }

  /** Committed history cells for the current turn (B2). */
  getCommittedHistoryCells(): HistoryCellRecord[] {
    return this._historyTranscript.getCommittedRecords();
  }

  /** Active in-flight cell, if any (thinking or streaming assistant). */
  getActiveHistoryCell(): HistoryCellRecord | null {
    return this._historyTranscript.getActiveRecord();
  }

  /** Cache key for active-cell transcript overlay refresh. */
  getActiveHistoryCellCacheKey(): string | null {
    return this._historyTranscript.getActiveCacheKey();
  }

  /** All history cell records (committed + active) for the current turn. */
  getHistoryCellRecords(): HistoryCellRecord[] {
    return this._historyTranscript.getAllRecords();
  }

  /** Virtual scroll viewport over history cells (B4). */
  getHistoryCellViewport(): HistoryCellViewport {
    return this._cellViewport;
  }

  /** Pre-warm transcript search index (B5). Returns warm duration in ms. */
  warmTranscriptSearchIndex(): number {
    this._syncCellViewport();
    return this._cellViewport.warmSearchIndex();
  }

  private _syncCellViewport(): void {
    this._cellViewport.syncFromTranscript(this._historyTranscript);
    this._paintCellViewportIfManaged();
  }

  private _paintCellViewportIfManaged(): void {
    if (!this.screenManager) return;
    this.screenManager.attachHistoryCellViewport(this._cellViewport);
    this.screenManager.renderContentArea();
    this.screenManager.drawBottomStats();
  }

  /**
   * Unified terminal resize handler — thinking overlay, streaming reflow,
   * cell viewport width, and ScreenManager content reflow (B6).
   */
  private _handleTerminalResize(width: number, height: number): void {
    if (!this.isTTY || this.outputBroken) return;
    if (this.paused) return;

    this._mdAccumulator.setViewportHeight(height);
    this._mdAccumulator.setTerminalWidth(width);
    this._cellViewport.setWidth(width);
    this._syncCellViewport();

    if (this.screenManager) {
      this.screenManager.refreshDimensions();
    }

    if (this._state === 'thinking' && this._pendingToolCallLines === 0) {
      this._writeThinkingLine();
    }

    if (this._state !== 'streaming' || this.answerChunks.length === 0) {
      return;
    }

    const oldLines = this._mdAccumulator.totalLines;
    if (oldLines <= 0) return;

    this._chunkCoalescer.drain();
    clearMdRenderCache();

    if (this._twoRegion) {
      this._twoRegion.onResize(height, width);
    }

    const reflowed = this._mdAccumulator.reflow(width, renderMarkdown);
    if (!reflowed) return;

    if (this._twoRegion?.isHardwareMode) {
      this._twoRegion.replaceStreamingContent(reflowed);
      return;
    }

    const viewportRows = height;
    const cursorUp = Math.min(oldLines, Math.max(1, viewportRows - 1));
    safeStdoutWrite(`\x1b[${cursorUp}A\x1b[J${reflowed}`);
  }

  /** Fix 1+3: FrameScheduler tick — updates live elapsed time + spinner.
   *  Only active during the "thinking" phase (before first answer chunk).
   *  Fix 2: Fades indicator toward red when no activity for >3s.
   *  Fix 5: Shows running background task labels inline.
   *  Fix: Skip tick when tool call indicators are visible to prevent
   *  \r\x1b[K from erasing active tool call lines. */
  private _tick(): void {
    if (this.paused || this.outputBroken) return;
    if (this._state !== 'thinking') return;
    if (this._pendingToolCallLines > 0) return;
    this._spinnerFrame = (this._spinnerFrame + 1) % SPINNER_FRAMES.length;
    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      this._writeThinkingLine();
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  /** Render the live thinking/progress line with optional bg task row below.
   *  All writes are batched into a single safeStdoutWrite call per frame. */
  private _writeThinkingLine(): void {
    if (!this.isTTY) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const spinner = SPINNER_FRAMES[this._spinnerFrame] ?? '◐';
    const stallMs = Date.now() - this._lastActivityTime;

    // Apply shimmer to the "Thinking…" label for live-streaming feedback.
    // In reduced-motion mode, shimmerText returns plain text (no-op).
    const motionMode = getMotionMode();
    const thinkingLabel = shimmerText('Thinking…', motionMode);

    let indicator = dim(`${spinner} ${thinkingLabel}`);
    // Fix 2: After STALL_THRESHOLD_MS without activity, fade toward red
    if (stallMs > STALL_THRESHOLD_MS) {
      const intensity = Math.min((stallMs - STALL_THRESHOLD_MS) / 2000, 1);
      if (intensity > 0.6) {
        indicator = warning(indicator);
      } else if (intensity > 0.3) {
        indicator = `${dim(spinner)} ${warning(thinkingLabel)}`;
      }
    }

    const timer = muted(`(${elapsed}s)`);

    // Build combined overlay: background tasks + subagent progress.
    const overlayLines: string[] = [];

    // Background-task overlay (existing pattern)
    const bgOverlay = renderBackgroundTaskOverlay();
    if (bgOverlay !== null) {
      overlayLines.push(...bgOverlay.split('\n'));
    }

    // Gap #4: Subagent progress overlay below background tasks.
    if (this._subAgents.size > 0) {
      overlayLines.push(...this._buildSubAgentLines());
    }

    // Batch all writes into a single string to minimise OutputBuffer calls.
    let output = `\r\x1b[K  ${indicator}  ${timer}`;

    const cols = process.stdout.columns ?? getTerminalWidth();
    if (overlayLines.length > 0) {
      for (const line of overlayLines) {
        const fitted = truncate(stripAnsi(line), Math.max(1, cols - 2));
        output += `\n${fitted}\x1b[K`;
      }
      // Move cursor back up to the thinking line for the next tick
      output += `\x1b[${overlayLines.length}A`;
      this._showingOverlayLines = overlayLines.length;
    } else if (this._showingOverlayLines > 0) {
      // All overlays gone — clear the previously shown rows
      for (let i = 0; i < this._showingOverlayLines; i++) {
        output += '\n\x1b[K';
      }
      output += `\x1b[${this._showingOverlayLines}A`;
      this._showingOverlayLines = 0;
    }

    safeStdoutWrite(output);
  }

  /** Record activity for stall detection (Fixes 2+7). Transitions state to
   *  'streaming' on first answer evidence. */
  private _recordActivity(): void {
    this._lastActivityTime = Date.now();
    if (this._state === 'thinking' && this.answerChunks.length > 0) {
      this._state = 'streaming';
      this._store?.dispatch({ type: 'state:transition', to: 'streaming' });
      // Clear the live thinking line and any overlay rows — answer text takes over
      if (this.isTTY) {
        safeStdoutWrite('\r\x1b[K');
        if (this._showingOverlayLines > 0) {
          // Clear all overlay lines (bg tasks + subagent progress)
          for (let i = 0; i < this._showingOverlayLines; i++) {
            safeStdoutWrite('\n\x1b[K');
          }
          safeStdoutWrite(`\x1b[${this._showingOverlayLines}A`);
          this._showingOverlayLines = 0;
        }
      }
      // Unregister permanent dirty — no more spinner ticks needed
      const scheduler = FrameScheduler.getInstance();
      scheduler.setComponentPermanentDirty('thinking-spinner', false);
      this._unregisterTick?.();
      this._unregisterTick = null;
    }
  }

  enableRawMode(): void {
    if (this._rawMode.isActive) return;
    this._rawMode.enable((event) => {
      const action = KeybindingManager.getInstance().matchStack(['chat'], event);

      switch (action) {
        case 'cancel':
          // Esc cancels — notify host to abort in-flight HTTP request
          if (this._cancelCallback) {
            try {
              this._cancelCallback();
            } catch {
              /* best-effort */
            }
          }
          this.fail(new Error('Run cancelled (Esc).'));
          break;
        case 'suspend':
          process.kill(process.pid, 'SIGTSTP');
          return;
        case 'cancel_double': {
          // Double-tap timing logic stays inline (stateful)
          const now = Date.now();
          if (this.lastCancelTime && now - this.lastCancelTime < 1000) {
            this.stop();
            process.exit(130);
          }
          this.lastCancelTime = now;
          this.fail(new Error('Run cancelled (Ctrl+C). Double-press to exit.'));
          break;
        }
        case 'thought_toggle':
          if (this.thoughtText) {
            this.thoughtCollapsed = !this.thoughtCollapsed;
            if (this.isTTY) {
              if (this.thoughtCollapsed) {
                safeStdoutWrite(`\n  ${dim('Thought collapsed')}\n`);
              } else {
                safeStdoutWrite(`\n  ${dim('Thought expanded:')}\n`);
                const rendered = renderMarkdown(this.thoughtText);
                for (const line of rendered.split('\n')) {
                  safeStdoutWrite(`  ${dim(line)}\n`);
                }
              }
            }
          }
          break;
        case 'pause_toggle':
          if (this.paused) {
            this.paused = false;
            this._store?.dispatch({ type: 'pause:toggle', paused: false });
            if (this.isTTY) {
              safeStdoutWrite('\r\x1b[K');
              safeStdoutWrite(`  ${dim('▶ Resumed')}\n`);
              safeStdoutWrite('\x1b[?25l');
            }
          } else {
            this.paused = true;
            this._store?.dispatch({ type: 'pause:toggle', paused: true });
            if (this.isTTY) {
              safeStdoutWrite('\x1b[?25h');
              safeStdoutWrite(
                `\n  ${activeAccent('⏸ Paused')}  ${dim('[P] resume  [Esc] cancel')}\n`,
              );
            }
          }
          break;
        case 'scroll_to_bottom':
          this._userScrolledUp = false;
          this._unseenCount = 0;
          this._cellViewport.scrollToBottom();
          // Delegate to ScreenManager if available for full-screen scroll management
          if (this.screenManager) {
            this.screenManager.scrollToBottom();
          } else if (this.isTTY) {
            // In pure stdout mode, just clear the unseen state
            safeStdoutWrite(`\r\x1b[K`);
          }
          break;
        case 'scroll_up':
          this._userScrolledUp = true;
          this._cellViewport.scrollBy(1);
          // Delegate to ScreenManager for scroll offset management
          if (this.screenManager) {
            this.screenManager.setScrollOffset((this.screenManager.getScrollOffset() ?? 0) + 1);
          }
          break;
        case 'scroll_down':
          if (this.screenManager) {
            const offset = this.screenManager.getScrollOffset() ?? 0;
            const next = Math.max(0, offset - 1);
            this._cellViewport.setScrollOffset(next);
            this.screenManager.setScrollOffset(next);
            if (next === 0) {
              this._userScrolledUp = false;
              this._unseenCount = 0;
            }
          } else {
            this._cellViewport.scrollBy(-1);
            // In pure stdout mode, scroll_down at offset 0 returns to bottom
            if (this._cellViewport.getScrollInfo().isAtBottom || this._unseenCount > 0) {
              this._userScrolledUp = false;
              this._unseenCount = 0;
            }
          }
          break;
        default:
          break;
      }
    });
  }

  setScrollback(buffer: ScrollbackBuffer): void {
    this.scrollback = buffer;
  }
  setScreenManager(sm: ScreenManager | undefined): void {
    this.screenManager = sm;
    if (sm) {
      this._syncCellViewport();
      sm.attachHistoryCellViewport(this._cellViewport);
    }
  }
  setTaskLabel(label: string): void {
    this.taskLabel = label;
  }

  // ── Multi-agent streaming API ───────────────────────────────────────────

  /** Register an agent for parallel output streaming. */
  registerAgent(agentId: string): void {
    this._agentStreams.registerAgent(agentId);
  }

  /** Write an agent-labeled line to the output stream. */
  writeAgentLine(agentId: string, text: string): void {
    if (this.outputBroken || this.paused) return;
    this._agentStreams.push(agentId, { agentId, type: 'chunk', text });
    this._flushAgentStreams();
  }

  /** Indicate an agent started a tool call. */
  onAgentToolStart(agentId: string, tool: string, target: string): void {
    if (this.outputBroken || this.paused) return;
    this._agentStreams.push(agentId, { agentId, type: 'tool_start', tool, target });
    this._flushAgentStreams();
  }

  /** Indicate an agent completed a tool call. */
  onAgentToolComplete(agentId: string, tool: string, detail?: string): void {
    if (this.outputBroken || this.paused) return;
    // Type assertion needed: exactOptionalPropertyTypes rejects `detail?: string`
    // receiving `string | undefined` in an object literal, but the runtime
    // value (undefined when missing) is correct for optional properties.
    const event = { agentId, type: 'tool_complete' as const, tool, detail } as AgentStreamEvent;
    this._agentStreams.push(agentId, event);
    this._flushAgentStreams();
  }

  /** Get the color function for an agent (for consistent coloring). */
  getAgentColor(agentId: string): (text: string) => string {
    return this._agentStreams.getAgentColor(agentId);
  }

  /** Flush any pending agent stream events to the terminal. */
  private _flushAgentStreams(): void {
    const lines = this._agentStreams.drain();
    for (const line of lines) {
      safeStdoutWrite(line + '\n');
      this._pushLinesToScrollback(line);
    }
  }

  /** Push output lines to the scrollback buffer for reflow/replay. */
  private _pushLinesToScrollback(text: string): void {
    if (!this.scrollback || !text) return;
    const lines = text.split('\n');
    for (const line of lines) {
      this.scrollback.push(line.replace(/\r/g, ''));
    }

    // Track unseen lines when user is conceptually scrolled up.
    // This connects to the ScreenManager's scroll tracking when available,
    // so the unseen-divider pill shows accurate counts.
    if (this._userScrolledUp && lines.length > 0) {
      this._unseenCount += lines.length;
      if (this.screenManager) {
        this.screenManager.incrementUnseenCount(lines.length);
      } else if (this.isTTY) {
        // In pure stdout mode (no ScreenManager), write the pill directly
        // to the output so the user sees it in their terminal.
        this._maybeWritePill();
      }
    }
  }

  /** Write the unseen divider pill to stdout if there are unseen lines
   *  and no ScreenManager is managing the display. */
  private _maybeWritePill(): void {
    if (!this.isTTY || this.outputBroken) return;
    // Only write when there are unseen lines to report
    if (this._userScrolledUp && this._unseenCount > 0) {
      const pill = renderUnseenDividerPill(this._unseenCount);
      if (pill) {
        safeStdoutWrite(pill + '\n');
      }
    }
  }

  disableRawMode(): void {
    this._rawMode.disable();
  }

  /** Stream a chunk of natural-language answer text — the primary output. */
  onAnswerChunk(chunk: string): void {
    if (this.outputBroken) return;
    if (this.paused) return;
    if (this._state === 'done' || this._state === 'failed') return;
    if (!chunk) return;
    // Fix: push BEFORE _recordActivity so the first chunk triggers
    // the 'thinking' → 'streaming' state transition.
    this.answerChunks.push(chunk);
    this._historyTranscript.onAnswerChunk(chunk);
    this._syncCellViewport();
    this._recordActivity();
    this._store?.dispatch({ type: 'answer:chunk', text: chunk });
    // Clear "Thinking…" on first chunk (length is now 1 after push)
    if (this.answerChunks.length === 1 && this.isTTY) {
      safeStdoutWrite('\r\x1b[K');
    }
    if (this.isTTY) {
      // Use incremental markdown rendering — only emit the delta
      // since the last chunk, avoiding O(n²) per-chunk re-rendering.
      // Deltas are batched through ChunkCoalescer for 16ms windows,
      // reducing terminal writes by 10-30× with no visible latency.
      const delta = this._mdAccumulator.feed(chunk, renderMarkdown);
      if (delta) {
        this._chunkCoalescer.push(delta);
      }
    }
  }

  /** Show inline approval pending indicator before PermissionDialog opens. */
  showApprovalPending(tool: string, target: string): void {
    if (this.outputBroken || !this.isTTY) return;
    this._approvalPending = { tool, target };
    const label = conversationalToolLabel(tool, target);
    safeStdoutWrite(`\n  ${warning('⏸')} ${warning('Approval required:')} ${label}`);
  }

  /** Clear approval pending indicator after dialog closes. */
  clearApprovalPending(): void {
    this._approvalPending = null;
  }

  /** Tool call starts — show a brief conversational indicator with spinner. */
  onToolCallStart(tool: string | undefined, target: string | undefined): number {
    if (this.outputBroken) return -1;
    if (this.paused) return -1;
    if (this._state === 'done' || this._state === 'failed') return -1;
    if (tool === undefined || target === undefined) return -1;
    this._recordActivity();
    const id = ++this.toolCallIndex;

    // Dispatch FIRST — returns false if middleware cancelled
    if (this._store && !this._store.dispatch({ type: 'tool:start', toolId: id, tool, target })) {
      this.toolCallIndex--; // revert the id allocation
      return -1;
    }

    // Store accepted — now mutate renderer state
    this.toolCallCount++;
    this.pendingToolCalls.set(id, { tool, target });
    this._historyTranscript.beginToolCall(id, tool, target);
    this._syncCellViewport();
    if (this.isTTY) {
      // Increment BEFORE safeStdoutWrite to close a race window with
      // _tick() — the FrameScheduler tick skips when _pendingToolCallLines > 0,
      // but if the tick fires between the write and the increment it would
      // emit \r\x1b[K and erase the freshly-printed tool call indicator.
      this._pendingToolCallLines++;
      const label = conversationalToolLabel(tool, target);
      safeStdoutWrite(`\n  ${dim('○')} ${label}`);
    }
    if (isA11yMode()) {
      a11yToolEvent(tool, target);
    }
    return id;
  }

  /** Tool call completes — clear the indicator and show a brief completion. */
  onToolCallComplete(id: number, detail?: string): void {
    if (this.outputBroken) return;
    if (this.paused) return;
    if (this._state === 'done' || this._state === 'failed') return;
    this._recordActivity();

    // Read pending data WITHOUT deleting yet — needed for display
    const pending = this.pendingToolCalls.get(id);

    if (!pending) return; // was never in pendingToolCalls

    // Always clean up _pendingToolCallLines for a tool that was pending,
    // even if middleware cancels display — otherwise the spinner leaks.
    if (this.isTTY) {
      this._pendingToolCallLines = Math.max(0, this._pendingToolCallLines - 1);
    }

    // Dispatch FIRST — returns false if middleware cancelled
    if (
      this._store &&
      !this._store.dispatch({
        type: 'tool:complete',
        toolId: id,
        ...(detail !== undefined ? { detail } : {}),
      })
    ) {
      // Middleware cancelled display — clean up state but don't write to terminal
      this.pendingToolCalls.delete(id);
      return;
    }

    // Store accepted — now mutate renderer state
    this.pendingToolCalls.delete(id);
    this._historyTranscript.completeToolCall(id, detail);
    this._syncCellViewport();
    if (this.isTTY) {
      const label = conversationalToolLabel(pending.tool, pending.target);
      const detailStr = detail ? ` ${dim(`(${detail})`)}` : '';
      // Carriage-return to replace the "…" with "✓" on the same conceptual line
      safeStdoutWrite(`\r  ${success('✓')} ${label}${detailStr}\n`);
      this._pushLinesToScrollback(`  ${success('✓')} ${label}${detailStr}`);
    } else {
      const detailStr = detail ? ` (${detail})` : '';
      const line = `[${formatElapsed(Date.now() - this.startTime)}] ${pending.tool} ${pending.target}${detailStr}`;
      safeStdoutWrite(`${line}\n`);
      this._pushLinesToScrollback(line);
    }
  }

  /** File was changed — show a brief diff indicator. */
  onFileChanged(
    filePath: string,
    additions: number,
    deletions: number,
    diffContent?: string | null,
  ): void {
    if (this.outputBroken) return;
    if (this.paused) return;
    this._store?.dispatch({ type: 'file:changed', filePath, additions, deletions });
    if (this.isTTY) {
      const parts: string[] = [];
      if (additions > 0) parts.push(success(`+${additions}`));
      if (deletions > 0) parts.push(error(`-${deletions}`));
      const mainLine = `  ${dim('└')} ${hyperlinkFile(filePath, info(filePath))} ${parts.join(' ')}`;
      safeStdoutWrite(`${mainLine}\n`);
      this._pushLinesToScrollback(mainLine);

      // Render inline unified diff content if available
      if (diffContent && typeof diffContent === 'string' && diffContent.trim().length > 0) {
        const allLines = diffContent.split('\n');
        const maxLines = 20;
        const diffLines = allLines.slice(0, maxLines);
        // Batch 2: Compute gutter width from hunk headers for line numbers
        let gutterWidth = 0;
        for (const diffLine of diffLines) {
          if (diffLine.startsWith('@@')) {
            const m = diffLine.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (m)
              gutterWidth = Math.max(gutterWidth, String(Number(m[1]) + diffLines.length).length);
          }
        }
        if (gutterWidth === 0) gutterWidth = 4;
        const gutter = (num: number): string => dim(String(num).padStart(gutterWidth) + ' │ ');
        let lineNum = 0;
        const diffOut: string[] = [];
        for (const diffLine of diffLines) {
          // +++ or --- file headers — dim, no line number
          if (diffLine.startsWith('+++') || diffLine.startsWith('---')) {
            const rendered = `  ${dim(' '.repeat(gutterWidth) + '  ' + diffLine)}`;
            diffOut.push(rendered);
            // Hunk header (@@ ... @@) — parse new-file line number
          } else if (diffLine.startsWith('@@')) {
            const m = diffLine.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (m) lineNum = Number(m[1]) - 1;
            const rendered = `  ${dim(' '.repeat(gutterWidth) + '  ' + diffLine)}`;
            diffOut.push(rendered);
            // Added lines — green with gutter
          } else if (diffLine.startsWith('+')) {
            lineNum++;
            const rendered = `  ${gutter(lineNum)}${success(diffLine)}`;
            diffOut.push(rendered);
            // Removed lines — red, no line number increment (old file)
          } else if (diffLine.startsWith('-')) {
            const rendered = `  ${dim(' '.repeat(gutterWidth) + ' │ ')}${error(diffLine)}`;
            diffOut.push(rendered);
            // Context lines — dim with gutter
          } else {
            lineNum++;
            const rendered = `  ${gutter(lineNum)}${dim(diffLine)}`;
            diffOut.push(rendered);
          }
        }
        if (allLines.length > maxLines) {
          diffOut.push(`  ${dim('... (' + (allLines.length - maxLines) + ' more lines)')}`);
        }
        const fullDiff = diffOut.join('\n');
        safeStdoutWrite(fullDiff + '\n');
        this._pushLinesToScrollback(fullDiff);
      }
    }
  }

  /** End of run — show a clean summary line. */
  onSummary({ costUSD, perRunCost }: SummaryOptions = {}): void {
    if (this.outputBroken) return;
    if (this.isTTY) safeStdoutWrite('\r\x1b[K');
    const elapsed = formatElapsed(Date.now() - this.startTime);
    if (this.isTTY) {
      let output = `\n  ${dim('·')} ${muted(elapsed)}`;
      if (typeof perRunCost === 'number') {
        output += `  ${dim('·')} ${commandAccent(`$${perRunCost.toFixed(4)}`)} this turn`;
        if (typeof costUSD === 'number') {
          output += `  ${dim('·')} ${muted(`$${costUSD.toFixed(4)} total`)}`;
        }
      } else if (typeof costUSD === 'number') {
        output += `  ${dim('·')} ${commandAccent(`$${costUSD.toFixed(4)}`)}`;
      }
      if (this.toolCallCount > 0) {
        output += `  ${dim('·')} ${this.toolCallCount} tool call${this.toolCallCount !== 1 ? 's' : ''}`;
      }
      output += '\n';
      safeStdoutWrite(output);
      this._pushLinesToScrollback(output);
    }
  }

  /** Get the full accumulated answer text with markdown rendered to ANSI. */
  getAnswerText(): string {
    return renderMarkdown(this.answerChunks.join(''));
  }

  /** Get transcript for the run bundle with markdown rendered to ANSI.
   *  Includes thinking text so it survives beyond the live TUI session. */
  getTranscript(): string {
    const parts: string[] = [];
    if (this.thoughtText) {
      parts.push(dim('── Thinking ──'));
      parts.push(renderMarkdown(this.thoughtText));
      parts.push(dim('── Answer ──'));
    }
    parts.push(renderMarkdown(this.answerChunks.join('')));
    return parts.join('\n');
  }

  /** Snapshot summary of the conversational run (plain ANSI string, not a live HUD). */
  snapshot(): string {
    const elapsed = formatElapsed(Date.now() - this.startTime);
    const lines: string[] = [
      sectionLabel('── Run Complete ──'),
      `${muted('Duration')} ${elapsed}  ${muted('Tools')} ${String(this.toolCallCount)}`,
    ];
    if (this.answerChunks.length > 0) {
      const preview = this.answerChunks.join('').replace(/\n/g, ' ').slice(0, 120);
      lines.push('');
      lines.push(sectionLabel('Answer:'));
      lines.push(`  ${info(preview + (preview.length >= 120 ? dim('…') : ''))}`);
    }
    if (this.thoughtText) {
      const thoughtLines = renderMarkdown(this.thoughtText).trim().split('\n');
      const maxLines = 8;
      lines.push('');
      lines.push(sectionLabel('Thinking:'));
      if (thoughtLines.length > maxLines) {
        lines.push(dim(`  … (${thoughtLines.length - maxLines} more lines)`));
      }
      lines.push(...thoughtLines.slice(-maxLines).map((line) => `  ${dim(line)}`));
    }
    return lines.join('\n');
  }

  getFinalSnapshot(): string {
    return this.snapshot();
  }

  /** Accumulate thought/reasoning text for the renderer.
   *  Filters synthetic progress indicators so only real model reasoning
   *  is stored in thoughtText (and preserved in transcripts/snapshots). */
  onThought(chunk: string): void {
    if (!chunk) return;
    // Filter synthetic "Thinking… (N chars)" progress strings
    // from ChatEngine — these are spinner updates, not reasoning.
    if (/^Thinking… \(\d+ chars\)$/.test(chunk.trim())) return;
    this._recordActivity();
    this.thoughtText += chunk;
    this._store?.dispatch({ type: 'thought:chunk', text: chunk });
    // Show thinking progress visibly — update the live thinking line
    // so users see model deliberation in real time
    // Guard: skip thinking-line rewrite when tool-call indicator lines are visible,
    // preventing \r\x1b[K from erasing active tool call lines (M5).
    if (this.isTTY && this._state === 'thinking' && this._pendingToolCallLines === 0) {
      this._writeThinkingLine();
    }
  }

  /**
   * T4.1: User-visible notice when ChatEngine compacted conversation context.
   * Writes a one-line toast into the transcript (not as model thought text).
   */
  onContextCompacted(message?: string): void {
    if (this.outputBroken || this.paused) return;
    this._recordActivity();
    const line = message?.trim() || '[Context compacted…]';
    const display = this.isTTY ? dim(`  ${line}`) : `  ${line}`;
    safeStdoutWrite(`${display}\n`);
    this._pushLinesToScrollback(`  ${line}`);
  }

  // ── Gap #4: Subagent progress ────────────────────────────────────────────

  /** Track a newly spawned sub-agent in the thinking overlay. */
  onSubAgentStart(id: string, label: string, _model?: string): void {
    if (this.outputBroken || this.paused) return;
    this._recordActivity();
    this._subAgents.set(id, {
      label: label.length > 60 ? label.slice(0, 57) + '…' : label,
      startTime: Date.now(),
      status: 'running',
    });
  }

  /** Mark a sub-agent as complete in the thinking overlay. */
  onSubAgentComplete(id: string, summary: string, tokens?: number): void {
    if (this.outputBroken || this.paused) return;
    this._recordActivity();
    const agent = this._subAgents.get(id);
    if (!agent) return;
    agent.status = 'complete';
    if (tokens !== undefined) agent.tokens = tokens;

    // Auto-remove completed agents after ~5s so the overlay stays current
    setTimeout(() => {
      this._subAgents.delete(id);
    }, 5000);
  }

  /** Mark a sub-agent as failed in the thinking overlay. */
  onSubAgentFailed(id: string, error: string): void {
    if (this.outputBroken || this.paused) return;
    this._recordActivity();
    const agent = this._subAgents.get(id);
    if (!agent) return;
    agent.status = 'failed';
    agent.error = error.length > 80 ? error.slice(0, 77) + '…' : error;

    setTimeout(() => {
      this._subAgents.delete(id);
    }, 8000);
  }

  /** Build overlay lines for all tracked sub-agents below the thinking line. */
  private _buildSubAgentLines(): string[] {
    const all = Array.from(this._subAgents.entries());
    if (all.length === 0) return [];

    // Sort: running first, then failed, then completed (by start time within tier)
    const statusRank = (s: 'running' | 'complete' | 'failed') =>
      s === 'running' ? 0 : s === 'failed' ? 1 : 2;
    all.sort((a, b) => {
      const rankDiff = statusRank(a[1].status) - statusRank(b[1].status);
      if (rankDiff !== 0) return rankDiff;
      return a[1].startTime - b[1].startTime;
    });

    const maxVisible = 5;
    const visible = all.slice(0, maxVisible);
    const lines: string[] = [];

    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i]!;
      const info = entry[1];
      const isLast = i === visible.length - 1 && all.length <= maxVisible;
      const branch = isLast ? '└─' : '├─';
      const elapsed = formatElapsed(Date.now() - info.startTime);

      if (info.status === 'running') {
        const saSpinner = SPINNER_FRAMES[this._spinnerFrame] ?? '◐';
        lines.push(`  ${dim(branch)} ${saSpinner} ${info.label} ${dim(`(${elapsed})`)}`);
      } else if (info.status === 'failed') {
        const errStr = info.error ? ` ${dim(info.error)}` : '';
        lines.push(`  ${dim(branch)} ${error(`✗ ${info.label}`)}${errStr} ${dim(`(${elapsed})`)}`);
      } else {
        const tokensStr = info.tokens
          ? ` ${dim(`(${info.tokens.toLocaleString()} tokens)`)}`
          : '';
        lines.push(`  ${dim(branch)} ${dim(`✓ ${info.label} (${elapsed})`)}${tokensStr}`);
      }
    }

    if (all.length > maxVisible) {
      lines.push(`  ${dim('└─')} ${dim(`(+${all.length - maxVisible} more)`)}`);
    }

    return lines;
  }

  /** Start — hide cursor, register FrameScheduler tick for live timer,
   *  subscribe to background tasks, transition state to 'thinking'.
   *  Configures shimmer on the MarkdownAccumulator based on motion mode. */
  start(): void {
    this._historyTranscript.beginTurn();
    this._cellViewport.setWidth(process.stdout.columns ?? 80);
    this._syncCellViewport();
    this._state = 'thinking';
    this._store?.dispatch({ type: 'state:transition', to: 'thinking' });
    this._lastActivityTime = Date.now();
    // Gap #4: Reset subagent state for a new turn
    this._subAgents.clear();
    this._showingOverlayLines = 0;

    // Configure shimmer on the markdown accumulator based on motion mode
    const motionMode = getMotionMode();
    this._mdAccumulator.setShimmerEnabled(motionMode === MotionMode.Animated);

    // Set viewport dimensions for cursor-up clamping and CJK-aware
    // visual line counting in the markdown accumulator.
    if (this.isTTY) {
      this._mdAccumulator.setViewportHeight(process.stdout.rows ?? 24);
      this._mdAccumulator.setTerminalWidth(process.stdout.columns ?? 80);
    }

    // Set up two-region hardware-scroll streaming when the terminal supports it.
    // This partitions the terminal into a stable scrollback region (top) and a
    // mutable streaming region (bottom) where live markdown renders in-place.
    if (this.isTTY) {
      this._twoRegion = new TwoRegionStreaming();
      this._twoRegion.setup(process.stdout.rows ?? 24, undefined, process.stdout.columns ?? 80);
      if (this._twoRegion.isHardwareMode) {
        this._writeOutput = (text: string) => this._twoRegion!.writeStreaming(text);
      }
    }

    if (this.isTTY) {
      safeStdoutWrite('\x1b[?25l');
      this._writeThinkingLine();
    }
    this.enableRawMode();

    // Register with FrameScheduler for live spinner + elapsed timer.
    // Per-component scheduling: independent 200ms interval.
    const scheduler = FrameScheduler.getInstance();
    this._unregisterTick = scheduler.scheduleComponent('thinking-spinner', () => this._tick(), {
      intervalMs: FRAME_INTERVAL_MS,
      priority: 5,
      label: 'thinking-spinner',
    });
    scheduler.setComponentPermanentDirty('thinking-spinner', true);

    // Batch 2: Terminal resize — thinking overlay + streaming reflow (B6).
    // Single path via OutputBuffer (debounced; width + height).
    this._unregisterResize = OutputBuffer.getInstance().onResize((width: number, height: number) => {
      this._handleTerminalResize(width, height);
    });
    this._syncFromStore();
  }

  /** Stop — unregister FrameScheduler, unsubscribe bg tasks, transition
   *  state to terminal, show cursor. */
  stop(): void {
    // Fix 7: Terminal state
    if (this._state !== 'failed') {
      this._state = 'done';
      this._store?.dispatch({ type: 'state:transition', to: 'done' });
    }

    this._historyTranscript.finishTurn();
    this._syncCellViewport();
    // G3 finalize mid-table holdback, then flush coalescer
    if (this.isTTY) { const d = this._mdAccumulator.finalize(renderMarkdown); if (d) this._chunkCoalescer.push(d); }
    if (this._chunkCoalescer) { this._chunkCoalescer.flush(); this._chunkCoalescer.dispose(); }

    // Graduate streaming content to scrollback and tear down the two-region
    // hardware-scroll layout if it was active.
    if (this._twoRegion) {
      this._twoRegion.commitStreaming();
      this._twoRegion.teardown();
      this._twoRegion = null;
      this._writeOutput = safeStdoutWrite;
    }

    // Fix 1+3: Unregister FrameScheduler tick
    if (this._unregisterTick) {
      this._unregisterTick();
      this._unregisterTick = null;
    }
    FrameScheduler.getInstance().setComponentPermanentDirty('thinking-spinner', false);

    // Batch 2: Remove resize handler
    if (this._unregisterResize) {
      this._unregisterResize();
      this._unregisterResize = null;
    }

    this.paused = false;
    this.disableRawMode();
    if (this.isTTY) {
      // Show keyboard hint footer if any tool calls were made
      if (this.toolCallCount > 0) {
        // Build keybinding hints from available actions
        const hints: string[] = ['[Esc] cancel'];
        if (this.thoughtText) hints.push('[T] thought');
        if (this._checkpointAvailable) hints.push('[Ctrl+R] restore checkpoint');
        hints.push('[Ctrl+C] stop');
        safeStdoutWrite(`\n  ${dim(hints.join('  '))}\n`);
      }
      safeStdoutWrite('\n\x1b[?25h');
    }
    this.destroy();
  }

  /** Error — clear thinking line, unregister tick, show error, stop. */
  fail(error?: unknown): void {
    if (this.outputBroken) return;
    this._state = 'failed';
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    this._historyTranscript.abortTurn();
    this._syncCellViewport();
    this._store?.dispatch({ type: 'error', message });
    // Flush and dispose any buffered chunks before showing error
    if (this._chunkCoalescer) {
      this._chunkCoalescer.flush();
      this._chunkCoalescer.dispose();
    }
    if (this.isTTY) safeStdoutWrite('\r\x1b[K');
    // Unregister tick immediately so spinner doesn't overwrite error
    if (this._unregisterTick) {
      this._unregisterTick();
      this._unregisterTick = null;
    }
    FrameScheduler.getInstance().setComponentPermanentDirty('thinking-spinner', false);

    // Tear down two-region streaming before writing error so DECSTBM
    // doesn't constrain the error box positioning.
    if (this._twoRegion) {
      this._twoRegion.teardown();
    }

    // Render a styled error box with context-sensitive details.
    const width = Math.min(getEffectiveTerminalWidth(), 80);
    const lines = renderErrorBox(message, error, width);
    safeStdoutWrite(`\n${lines.join('\n')}\n`);
    for (const line of lines) {
      this._pushLinesToScrollback(line);
    }
    this.stop();
  }
}
