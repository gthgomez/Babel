import {
  activeAccent,
  muted,
  dim,
  info,
  sectionLabel,
  success,
  error,
  warning,
  getEffectiveTerminalWidth,
  hyperlinkFile,
} from './theme.js';
import { renderMarkdown, clearMdRenderCache } from './highlight.js';
import { RawModeManager } from './rawMode.js';
import { KeybindingManager } from './keybindings.js';
import { FrameScheduler } from './frameScheduler.js';
import { composeThinkingHud, leaveThinking, type ThinkingExitReason } from './thinkingState.js';
import { canUseCursorRewrite } from './cursorRewritePolicy.js';
import { MarkdownAccumulator } from './markdownAccumulator.js';
import { renderBackgroundTaskOverlay } from './backgroundTaskOverlay.js';
import { ScrollbackBuffer } from './scrollback.js';
import { ScreenManager } from './screenManager.js';
import { OutputBuffer } from './outputBuffer.js';
import { isA11yMode, a11yToolEvent } from './a11y.js';
import { ChunkCoalescer } from './chunkCoalescer.js';
import { TwoRegionStreaming } from './twoRegionStreaming.js';
import { AgentStreamManager, type AgentStreamEvent } from './agentProgress.js';
import { getMotionMode, MotionMode } from './motion.js';
import { renderUnseenDividerPill } from './unseenDivider.js';
import { StateStore, createTuiStore, type TuiMutation, type TuiState } from './stateMutationBus.js';
import { HistoryCellViewport, HistoryTranscript } from './historyCells/index.js';
import { appendStreamingDraft } from './interruptHost.js';
import { isDuplicateCtrlC, markCtrlCHandled } from './inputCoordinator.js';
import type { HistoryCellRecord } from './historyCells/types.js';
import type { ChatPhase } from '../agent/chatPhaseNudge.js';
import {
  ConversationLivenessTracker,
  formatConversationThinkingStatus,
  type ConversationLivenessSnapshot,
} from './conversationLiveness.js';
import {
  classifyToolPresentation,
  formatToolGroupSummary,
  groupToolExecutions,
  type ToolExecutionSummary,
} from './toolPresentation.js';
import { renderSubAgentOverlay, type SubAgentOverlayEntry } from './subAgentOverlay.js';
import { recordLiveActivity } from './liveActivity.js';
import { conversationalToolLabel } from './toolDisplay.js';
import {
  BaseRenderer,
  FRAME_INTERVAL_MS,
  SPINNER_FRAMES,
  formatElapsed,
  renderErrorBox,
  safeStdoutWrite,
  type SummaryOptions,
} from './rendererSupport.js';

/**
 * Conversational streaming renderer for Chat mode.
 *
 * Mimics Claude Code / Codex: natural language flows freely, tool calls appear
 * as brief transient indicators, and the final output reads like a conversation.
 */
export class ConversationalRenderer extends BaseRenderer {
  private isTTY: boolean | undefined;
  private answerChunks: string[];
  /** True after at least one answer_chunk in the current assistant generation. */
  private _currentGenerationHasStream = false;
  /** True after turn metadata has been written; later assistant bytes are illegal. */
  private _turnMetadataStarted = false;
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
   * Mutable function reference for writing output chunks in fallback
   * (non-hardware) mode. Defaults to safeStdoutWrite.
   *
   * Hardware two-region mode does not use this hook: the ChunkCoalescer
   * paints via replaceStreamingContent(getRenderedText()) so Case-3
   * rewrite deltas cannot be appended as extra answer copies.
   */
  private _writeOutput: (text: string) => void = safeStdoutWrite;
  private _agentStreams: AgentStreamManager;
  private _cancelCallback: ((...args: unknown[]) => unknown) | null;
  private _state: string;
  private _lastActivityTime: number;
  private readonly _liveness: ConversationLivenessTracker;
  private _spinnerFrame: number;
  private _unregisterTick: (() => void) | null;
  private _resizeHandler: (() => void) | null;
  /** Unregister function returned by OutputBuffer.onResize for the reflow callback. */
  private _unregisterResize: (() => void) | null;
  private _checkpointAvailable: boolean;
  /** Total overlay lines shown below the thinking line (bg tasks + subagents). */
  private _showingOverlayLines: number;
  /** Gap #4: Active subagents tracked during the thinking phase. */
  private _subAgents: Map<string, SubAgentOverlayEntry> = new Map();
  private _toolFrameIndex: number;
  private scrollback: ScrollbackBuffer | undefined;
  private screenManager: ScreenManager | undefined;
  private taskLabel: string | undefined;
  private readonly _rawMode: RawModeManager;
  /** Hosted North Star shells own stdin; legacy renderers retain raw input. */
  private ownsInput: boolean;

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
  /** Buffer for accumulating consecutive tool execution summaries to group them into N-item lines. */
  private _pendingToolExecutions: ToolExecutionSummary[] = [];

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

  public verboseMode: boolean = false;

  constructor(
    {
      isTTY,
      stateStore,
      verboseMode,
      ownsInput = true,
    }: {
      isTTY?: boolean;
      stateStore?: StateStore<TuiState, TuiMutation> | undefined;
      verboseMode?: boolean;
      ownsInput?: boolean;
    } = { isTTY: process.stdout.isTTY },
  ) {
    super();
    this.ownsInput = ownsInput;
    this.verboseMode = verboseMode ?? false;
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
        // Hardware two-region paints from the accumulator snapshot. Feeding
        // Case-3 cursor-up rewrite deltas through writeStreaming() appends
        // another copy of the answer (and the CSI itself) into the line
        // buffer — the Windows Terminal smear/reprint bug.
        if (this._twoRegion?.isHardwareMode) {
          this._twoRegion.replaceStreamingContent(this._mdAccumulator.getRenderedText());
          return;
        }
        this._writeOutput(batch);
        this._pushLinesToScrollback(batch);
      },
      16, // 16ms batch window (~60 FPS)
    );
    this._agentStreams = new AgentStreamManager();
    this._cancelCallback = null;
    this._state = 'idle';
    this._lastActivityTime = Date.now();
    this._liveness = new ConversationLivenessTracker();
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
    this._cellViewport = new HistoryCellViewport(OutputBuffer.getTerminalSize().cols);
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

  /**
   * Whether DECSTBM two-region streaming is active.
   * Test/inspection helper.
   */
  isTwoRegionHardwareMode(): boolean {
    return this._twoRegion?.isHardwareMode === true;
  }

  /**
   * Logical lines held by hardware two-region streaming (including graduated).
   * Empty when hardware mode is off. Test/inspection helper.
   */
  getTwoRegionLogicalLines(): readonly string[] {
    return this._twoRegion?.getLogicalLines() ?? [];
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

    if (this._twoRegion?.isHardwareMode) {
      const reflowedHw = this._mdAccumulator.reflow(width, renderMarkdown);
      if (reflowedHw) this._twoRegion.replaceStreamingContent(reflowedHw);
      return;
    }

    if (!canUseCursorRewrite()) {
      // ConPTY cannot apply CUU/ED. Keep already-emitted cells; future wraps
      // use the updated width. Do not desync lastRendered via a silent reflow.
      return;
    }

    const reflowed = this._mdAccumulator.reflow(width, renderMarkdown);
    if (!reflowed) return;

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
    const spinner = SPINNER_FRAMES[this._spinnerFrame] ?? '◐';
    const stallMs = Date.now() - this._lastActivityTime;
    const { indicator, timer } = formatConversationThinkingStatus({
      spinner,
      stallMs,
      snapshot: this._liveness.snapshot(this.startTime),
    });

    // Build combined overlay: background tasks + subagent progress.
    const overlayLines: string[] = [];

    // Background-task overlay (existing pattern)
    const bgOverlay = renderBackgroundTaskOverlay();
    if (bgOverlay !== null) {
      overlayLines.push(...bgOverlay.split('\n'));
    }

    // Gap #4: Subagent progress overlay below background tasks.
    if (this._subAgents.size > 0) {
      overlayLines.push(
        ...renderSubAgentOverlay(
          this._subAgents,
          SPINNER_FRAMES[this._spinnerFrame] ?? '◐',
        ),
      );
    }

    const cols = OutputBuffer.getTerminalSize().cols;
    const hud = composeThinkingHud({
      indicatorLine: `  ${indicator}  ${timer}`,
      overlayLines,
      columns: cols,
      previousOverlayLines: this._showingOverlayLines,
    });
    this._showingOverlayLines = hud.showingOverlayLines;
    safeStdoutWrite(hud.output);
  }

  /** Leave the thinking state (on first answer chunk, tool call start, or turn finish/error).
   *  Always clears the thinking spinner line, then any _showingOverlayLines, before subsequent writes. */
  private _leaveThinking(reason: ThinkingExitReason): void {
    const result = leaveThinking({ state: this._state, reason, isTTY: this.isTTY === true, overlayLines: this._showingOverlayLines,
      write: safeStdoutWrite, transition: (state) => { this._state = state; this._store?.dispatch({ type: 'state:transition', to: state }); }, unregisterTick: this._unregisterTick });
    this._state = result.state; this._showingOverlayLines = result.overlayLines; this._unregisterTick = result.unregisterTick;
  }

  /** Record activity for stall detection (Fixes 2+7). Transitions state to
   *  'streaming' on first answer evidence. */
  private _recordActivity(): void {
    this._lastActivityTime = Date.now();
    if (this._state === 'thinking' && this.answerChunks.length > 0) {
      this._leaveThinking('stream');
    }
  }

  private _recordModelActivity(): void {
    this._liveness.recordModelActivity();
    this._recordActivity();
  }

  /** Update the operator-visible phase before the next provider wait begins. */
  onPhaseChange(phase: ChatPhase): void {
    if (this._state === 'done' || this._state === 'failed') return;
    this._liveness.setPhase(phase);
    if (this._pendingToolCallLines > 0) return;
    if (this._state !== 'thinking') {
      this._state = 'thinking';
      this._store?.dispatch({ type: 'state:transition', to: 'thinking' });
      this._lastActivityTime = Date.now();
      if (this.isTTY) safeStdoutWrite('\n');
    }
    if (this.isTTY) this._writeThinkingLine();
    this._registerThinkingTicker();
  }

  getLivenessSnapshot(): ConversationLivenessSnapshot {
    return this._liveness.snapshot(this.startTime);
  }

  override enableRawMode(): void {
    if (!this.ownsInput) return;
    if (this._rawMode.isActive) return;
    this._rawMode.enable((event) => {
      const action = KeybindingManager.getInstance().matchStack(['chat'], event);

      switch (action) {
        case 'cancel':
          if (this._cancelCallback) {
            try {
              this._cancelCallback();
            } catch {
              /* best-effort */
            }
          }
          this.cancelRun();
          break;
        case 'suspend':
          process.kill(process.pid, 'SIGTSTP');
          return;
        case 'cancel_double': {
          if (isDuplicateCtrlC()) break;
          markCtrlCHandled();
          if (this._cancelCallback) {
            try {
              this._cancelCallback();
            } catch {
              /* best-effort */
            }
          }
          this.cancelRun();
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
          if (
            event.name &&
            event.name.length === 1 &&
            !event.ctrl &&
            !event.meta &&
            event.name !== 'escape'
          ) {
            appendStreamingDraft(event.sequence || event.name);
          }
          break;
      }
    });
  }

  override isRawModeActive(): boolean {
    return this._rawMode.isActive;
  }

  override setInputOwnership(ownsInput: boolean): void {
    if (this.ownsInput === ownsInput) return;
    this.ownsInput = ownsInput;
    if (!ownsInput) {
      this.disableRawMode();
      return;
    }
    // A renderer can outlive the shell host across a responsive transition.
    // Reclaim raw input only while its turn is still live; idle PromptInput
    // remains the sole legacy owner.
    if (this.isTTY && this._state !== 'done' && this._state !== 'failed') {
      this.enableRawMode();
    }
  }

  override resumeTicks(): void {
    super.resumeTicks();
    this._twoRegion?.reconcileAfterExclusiveSurface();
    if (this._twoRegion?.isHardwareMode) {
      this._twoRegion.replaceStreamingContent(this._mdAccumulator.getRenderedText());
    }
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

  override disableRawMode(): void {
    this._rawMode.disable();
  }

  /**
   * Settle the active assistant stream.
   *
   * After this returns, no assistant bytes received before the call may be
   * written to stdout again. Shared by end-of-turn, generation boundaries,
   * and tool boundaries.
   *
   * @param persistHardwareRegion - when true (generation/tool seam), keep
   *   DECSTBM active and open a fresh streaming message. When false
   *   (end of turn), graduate and drop the hardware region.
   */
  finalizeAnswerStream(persistHardwareRegion = false): void {
    const hasStream =
      this._currentGenerationHasStream ||
      this._mdAccumulator.totalBytes > 0 ||
      this.answerChunks.length > 0;
    if (hasStream) {
      this._historyTranscript.flushActive();
      this._syncCellViewport();
      if (this.isTTY) {
        const held = this._mdAccumulator.finalize(renderMarkdown);
        if (held) this._chunkCoalescer.push(held);
        this._chunkCoalescer.flush();
      }
      this._mdAccumulator.reset();
      this._currentGenerationHasStream = false;
      if (persistHardwareRegion) {
        // Generation/tool seam: the next segment must start from a clean
        // live buffer so answers never concatenate across boundaries.
        this.answerChunks = [];
        if (this._twoRegion?.isHardwareMode) this._twoRegion.beginNewStreamingMessage();
      } else {
        // End of turn: keep the settled text readable via getAnswerText() /
        // getTranscript(). Further assistant writes are already forbidden by
        // _turnMetadataStarted, and the hardware region graduates.
        if (this._twoRegion?.isHardwareMode) this._twoRegion.commitStreaming();
      }
    } else if (this.isTTY) {
      this._chunkCoalescer.flush();
    }
  }

  /**
   * A new model generation is starting (engine 'thinking' event with no
   * intervening tool call). Seal any in-flight streamed answer, then enter
   * the thinking state for the next provider round.
   */
  onAnswerGenerationBoundary(): void {
    if (this.outputBroken || this.paused) return;
    if (this._state === 'done' || this._state === 'failed') return;
    const hadStream =
      this._currentGenerationHasStream ||
      this.answerChunks.length > 0 ||
      this._mdAccumulator.totalBytes > 0;
    this.finalizeAnswerStream(true);
    if (!hadStream) return;
    this._state = 'thinking';
    this._store?.dispatch({ type: 'state:transition', to: 'thinking' });
    this._lastActivityTime = Date.now();
    if (this.isTTY) this._writeThinkingLine();
    this._registerThinkingTicker();
  }

  /** Stream a chunk of natural-language answer text — the primary output. */
  onAnswerChunk(chunk: string): void {
    if (this.outputBroken) return;
    if (this.paused) return;
    if (this._state === 'done' || this._state === 'failed') return;
    if (this._turnMetadataStarted) return;
    if (!chunk) return;
    this._flushPendingToolExecutions();
    // Fix: push BEFORE _recordActivity so the first chunk triggers
    // the 'thinking' → 'streaming' state transition.
    this.answerChunks.push(chunk);
    this._currentGenerationHasStream = true;
    this._historyTranscript.onAnswerChunk(chunk);
    this._syncCellViewport();
    this._recordModelActivity();
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

  /** Flush accumulated consecutive tool execution summaries to the terminal. */
  private _flushPendingToolExecutions(): void {
    if (this._pendingToolExecutions.length === 0) return;
    if (this.outputBroken) {
      this._pendingToolExecutions = [];
      return;
    }
    const groups = groupToolExecutions(this._pendingToolExecutions);
    this._pendingToolExecutions = [];
    for (const group of groups) {
      const formatted = formatToolGroupSummary(group, this.verboseMode);
      if (this.isTTY) {
        safeStdoutWrite(`\r${formatted}\n`);
        this._pushLinesToScrollback(formatted);
      } else {
        safeStdoutWrite(`${formatted}\n`);
        this._pushLinesToScrollback(formatted);
      }
    }
  }

  /** Tool call starts — show a brief conversational indicator with spinner. */
  onToolCallStart(tool: string | undefined, target: string | undefined): number {
    if (this.outputBroken) return -1;
    if (this.paused) return -1;
    if (this._state === 'done' || this._state === 'failed') return -1;
    if (tool === undefined || target === undefined) return -1;
    if (this._state === 'thinking') {
      this._leaveThinking('tool');
    }
    this._recordModelActivity();
    recordLiveActivity({ tool, target });

    // If pending executions belong to a different category, flush them before starting new category
    if (this._pendingToolExecutions.length > 0) {
      const incomingGroup = groupToolExecutions([{ tool, target }])[0];
      const pendingGroup = groupToolExecutions(this._pendingToolExecutions)[0];
      if (incomingGroup?.category !== pendingGroup?.category || this.verboseMode) {
        this._flushPendingToolExecutions();
      }
    }

    const id = ++this.toolCallIndex;

    // Dispatch FIRST — returns false if middleware cancelled
    if (this._store && !this._store.dispatch({ type: 'tool:start', toolId: id, tool, target })) {
      this.toolCallIndex--; // revert the id allocation
      return -1;
    }

    // Store accepted — now mutate renderer state
    this.toolCallCount++;
    this.pendingToolCalls.set(id, { tool, target });
    this.finalizeAnswerStream(true);
    this._historyTranscript.beginToolCall(id, tool, target);
    this._syncCellViewport();
    if (this.isTTY) {
      // Increment BEFORE safeStdoutWrite to close a race window with
      // _tick() — the FrameScheduler tick skips when _pendingToolCallLines > 0,
      // but if the tick fires between the write and the increment it would
      // emit \r\x1b[K and erase the freshly-printed tool call indicator.
      this._pendingToolCallLines++;
      const label = conversationalToolLabel(tool, target);
      if (this._pendingToolExecutions.length === 0) {
        safeStdoutWrite(`\n  ${dim('○')} ${label}`);
      } else {
        safeStdoutWrite(`\r  ${dim('○')} ${label}`);
      }
    }
    if (isA11yMode()) {
      a11yToolEvent(tool, target);
    }
    return id;
  }

  onToolCallComplete(id: number, detail?: string, error?: string, exitCode?: number): void {
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

    const classification = classifyToolPresentation({ detail, error, exitCode });
    const isIntervention = classification.isFailure || classification.isBlocked || classification.availability === 'unavailable';

    const summary: ToolExecutionSummary = {
      tool: pending.tool,
      target: pending.target,
      status: classification.status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };

    if (this.isTTY) {
      if (this.verboseMode) {
        const group = groupToolExecutions([summary])[0] ?? {
          category: 'other' as const,
          count: 1,
          items: [summary],
          hasErrors: classification.isFailure,
          hasBlocked: classification.isBlocked || classification.availability === 'unavailable',
          hasUnknowns: classification.status === 'unknown',
        };
        const formatted = formatToolGroupSummary(group, true);
        safeStdoutWrite(`\r${formatted}\n`);
        this._pushLinesToScrollback(formatted);
      } else if (isIntervention) {
        this._flushPendingToolExecutions();
        const group = groupToolExecutions([summary])[0] ?? {
          category: 'other' as const,
          count: 1,
          items: [summary],
          hasErrors: classification.isFailure,
          hasBlocked: classification.isBlocked || classification.availability === 'unavailable',
          hasUnknowns: false,
        };
        const formatted = formatToolGroupSummary(group, false);
        safeStdoutWrite(`\r${formatted}\n`);
        this._pushLinesToScrollback(formatted);
      } else {
        this._pendingToolExecutions.push(summary);
      }
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
    if (this._pendingToolExecutions.length > 0) {
      const hasNonEdits = this._pendingToolExecutions.some(
        item => item.tool !== 'write_file' && item.tool !== 'str_replace' && item.tool !== 'apply_patch'
      );
      if (hasNonEdits) {
        this._flushPendingToolExecutions();
      }
    }
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
        // Compute gutter width from hunk headers for line numbers
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

  /** End of run — elapsed/tool-count only. Turn cost lives on the ReviewCard. */
  onSummary({ costUSD: _costUSD, perRunCost: _perRunCost }: SummaryOptions = {}): void {
    this.finalizeAnswerStream(false);
    this._flushPendingToolExecutions();
    if (this.outputBroken) return;
    this._turnMetadataStarted = true;
    if (this.isTTY) safeStdoutWrite('\r\x1b[K');
    const elapsed = formatElapsed(Date.now() - this.startTime);
    if (this.isTTY) {
      let output = `\n  ${dim('·')} ${muted(elapsed)}`;
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
    this._flushPendingToolExecutions();
    // Filter synthetic "Thinking… (N chars)" progress strings
    // from ChatEngine — these are spinner updates, not reasoning.
    if (/^Thinking… \(\d+ chars\)$/.test(chunk.trim())) return;
    this._recordModelActivity();
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
  /** W3 Phase 3 Progress Recovery Controller events */
  onProgressRecovery(
    intervention: import('../agent/progressController.js').ProgressInterventionLevel,
    source: string,
    score: number,
    message?: string,
  ): void {
    this._flushPendingToolExecutions();
    if (this.outputBroken || this.paused) return;

    // Only display an indicator if we're not at 'none' or if we want to show a recovery nudge.
    if (intervention === 'none' && !message) return;

    if (this.isTTY) {
      const levelColors = {
        none: success,
        nudge: info,
        restricted_tools: warning,
        last_chance_repair: error,
        terminal_blocked: error
      };

      const colorFn = levelColors[intervention] || dim;
      const title = colorFn(`[${intervention.toUpperCase()}]`);
      const body = message ? dim(` - ${message}`) : dim(` (Score: ${score})`);

      const line = `  ${dim('↳')} ${title} Progress/Recovery${body}`;
      safeStdoutWrite(`${line}\n`);
      this._pushLinesToScrollback(line);
    }
  }

  /**
   * User-visible notice when ChatEngine compacted conversation context.
   * Writes a one-line toast into the transcript (not as model thought text).
   */
  onContextCompacted(message?: string): void {
    this._flushPendingToolExecutions();
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
    this._flushPendingToolExecutions();
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

  /** Start — hide cursor, register FrameScheduler tick for live timer,
   *  subscribe to background tasks, transition state to 'thinking'.
   *  Configures shimmer on the MarkdownAccumulator based on motion mode. */
  start(): void {
    this._historyTranscript.beginTurn();
    this._currentGenerationHasStream = false;
    this._turnMetadataStarted = false;
    this._cellViewport.setWidth(OutputBuffer.getTerminalSize().cols);
    this._syncCellViewport();
    this._state = 'thinking';
    this._store?.dispatch({ type: 'state:transition', to: 'thinking' });
    this._lastActivityTime = Date.now();
    this._liveness.reset();
    // Gap #4: Reset subagent state for a new turn
    this._subAgents.clear();
    this._showingOverlayLines = 0;

    // Configure shimmer on the markdown accumulator based on motion mode
    const motionMode = getMotionMode();
    this._mdAccumulator.setShimmerEnabled(motionMode === MotionMode.Animated);

    this._mdAccumulator.setPaintPolicy(canUseCursorRewrite() ? 'csi' : 'append-only');

    // Set viewport dimensions for cursor-up clamping and CJK-aware
    // visual line counting in the markdown accumulator.
    if (this.isTTY) {
      const size = OutputBuffer.getTerminalSize();
      this._mdAccumulator.setViewportHeight(size.rows);
      this._mdAccumulator.setTerminalWidth(size.cols);
    }

    // Set up two-region hardware-scroll streaming when the terminal supports it.
    // This partitions the terminal into a stable scrollback region (top) and a
    // mutable streaming region (bottom) where live markdown renders in-place.
    // Hardware paints are applied in the ChunkCoalescer via replaceStreamingContent
    // (full snapshot), not writeStreaming(delta), so markdown rewrites cannot
    // append a second copy of the answer.
    if (this.isTTY) {
      this._twoRegion = new TwoRegionStreaming();
      const size = OutputBuffer.getTerminalSize();
      this._twoRegion.setup(size.rows, undefined, size.cols);
    }

    if (this.isTTY) {
      safeStdoutWrite('\x1b[?25l');
      this._writeThinkingLine();
    }
    this.enableRawMode();

    this._registerThinkingTicker();

    // Terminal resize — thinking overlay + streaming reflow (B6).
    // Single path via OutputBuffer (debounced; width + height).
    this._unregisterResize = OutputBuffer.getInstance().onResize((width: number, height: number) => {
      this._handleTerminalResize(width, height);
    });
    this._syncFromStore();
  }

  /** Register the 15s-status-friendly live timer after each model phase begins. */
  private _registerThinkingTicker(): void {
    if (this._unregisterTick) return;
    // Register with FrameScheduler for live spinner + elapsed/model-idle timer.
    // Per-component scheduling: independent 200ms interval.
    const scheduler = FrameScheduler.getInstance();
    this._unregisterTick = scheduler.scheduleComponent('thinking-spinner', () => this._tick(), {
      intervalMs: FRAME_INTERVAL_MS,
      priority: 5,
      label: 'thinking-spinner',
    });
    scheduler.setComponentPermanentDirty('thinking-spinner', true);
  }

  /** Stop — unregister FrameScheduler, unsubscribe bg tasks, transition
   *  state to terminal, show cursor. */
  stop(): void {
    this._flushPendingToolExecutions();
    // Fix 7: Terminal state
    if (this._state !== 'failed') {
      this._state = 'done';
      this._store?.dispatch({ type: 'state:transition', to: 'done' });
    }

    this._historyTranscript.finishTurn();
    this._syncCellViewport();
    this.finalizeAnswerStream(false);
    if (this._chunkCoalescer) { this._chunkCoalescer.dispose(); }

    if (this._twoRegion) {
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

    // Remove resize handler
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

  /**
   * Operator cancel — clear spinner/progress without painting a failure box.
   * The host review card is responsible for the CANCELLED label.
   */
  cancelRun(): void {
    this._flushPendingToolExecutions();
    if (this.outputBroken) return;
    if (this._state === 'thinking') {
      this._leaveThinking('end');
    }
    this._historyTranscript.abortTurn();
    this._syncCellViewport();
    if (this._chunkCoalescer) {
      this._chunkCoalescer.flush();
      this._chunkCoalescer.dispose();
    }
    if (this.isTTY) safeStdoutWrite('\r\x1b[K');
    if (this._unregisterTick) {
      this._unregisterTick();
      this._unregisterTick = null;
    }
    FrameScheduler.getInstance().setComponentPermanentDirty('thinking-spinner', false);
    if (this._twoRegion) {
      this._twoRegion.teardown();
    }
    this.stop();
  }

  /** Error — clear thinking line, unregister tick, show error, stop. */
  fail(error?: unknown): void {
    this._flushPendingToolExecutions();
    if (this.outputBroken) return;
    if (this._state === 'thinking') {
      this._leaveThinking('end');
    }
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
