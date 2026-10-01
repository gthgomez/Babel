import {
  accentBright,
  activeAccent,
  border,
  muted,
  primary,
  dim,
  bold,
  info,
  sectionLabel,
  success,
  error,
  getTerminalWidth,
  getEffectiveTerminalWidth,
  hyperlinkFile,
  stripAnsi,
  truncate,
} from './theme.js';
import { globalCostTracker } from '../services/costTracker.js';
import { renderMarkdown } from './highlight.js';
import { RawModeManager } from './rawMode.js';
import { KeybindingManager } from './keybindings.js';
import { FrameScheduler } from './frameScheduler.js';
import { OutputBuffer } from './outputBuffer.js';
import { isA11yMode, a11yStageEvent } from './a11y.js';
import {
  StateStore,
  createTuiStore,
  type TuiMutation,
  type TuiState,
  createInitialTuiState,
} from './stateMutationBus.js';
import { handleInteractiveInterrupt } from './interruptHost.js';
import {
  BaseRenderer,
  activityColor,
  activityKey,
  formatDuration,
  formatETA,
  formatElapsed,
  normalizeActivityLine,
  runtimeEventLabel,
  safeStdoutWrite,
  stageAction,
  successLike,
  type EventBus,
  type RendererContext,
  type RuntimeEvent,
} from './rendererSupport.js';

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

  override enableRawMode(): void {
    if (this._rawMode.isActive) return;
    this._rawMode.enable((event) => {
      const action = KeybindingManager.getInstance().matchStack(['governed'], event);

      switch (action) {
        case 'dismiss_error':
          if (this._store.currentState.renderState === 'failed') this.stop();
          break;
        case 'cancel':
          handleInteractiveInterrupt();
          this.fail(new Error('Run cancelled (Esc).'));
          break;
        case 'suspend':
          process.kill(process.pid, 'SIGTSTP');
          return;
        case 'cancel_double': {
          const result = handleInteractiveInterrupt();
          if (!result.exited) {
            this.fail(new Error('Run cancelled (Ctrl+C). Press Ctrl+C again to exit.'));
          }
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

  override isRawModeActive(): boolean {
    return this._rawMode.isActive;
  }

  override disableRawMode(): void {
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
      `${muted('Duration')} ${elapsed}  ${muted('Cost')} ${muted('$' + s.cachedCostStr)}  ${muted('Tools')} ${String(s.completedToolCalls)}`,
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
          `${muted('Time')} ${elapsed}   ${muted('Cost')} ${muted(`$${s.cachedCostStr}`)}`,
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
        `${muted('Time')} ${elapsed}   ${muted('Cost')} ${muted(`$${s.cachedCostStr}`)}`,
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

export class TtyHudRenderer extends WaterfallRenderer {}
