import * as readline from 'node:readline/promises';
import * as rl from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ReadlineWithHistory extends readline.Interface {
  history: string[];
}
import { dim } from '../ui/theme.js';
import {
  registerReadlineInterface,
  registerExclusiveTerminalRunner,
  withExclusiveStdin,
} from '../ui/inputCoordinator.js';
import { FocusTracker } from '../ui/focusTracker.js';
import { loadHistory } from '../services/history.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { createPromptInputAdapter, shouldUsePromptInputV2 } from '../ui/promptInputAdapter.js';
import { resolveAgentTarget, type AgentTargetContext } from '../services/targetResolver.js';
import { startLiteIndexWarmup } from '../services/liteIndexWarmup.js';
import { ScreenManager } from '../ui/screenManager.js';
import { PaneManager } from '../ui/paneManager.js';
import { CommandPalette } from '../ui/palette.js';
import { alert } from '../ui/dialog.js';
import { SessionPicker } from '../ui/sessionPicker.js';
import { preserveComposerAcrossResize } from '../ui/interruptHost.js';
import { openEditor } from './openEditor.js';
import {
  bootstrapReplSession,
  detectInitialProject,
  exitRepl,
  maybeShowResumePicker,
} from './repl/replLifecycle.js';
import { runReplLoop } from './repl/replLoop.js';
import { buildReplCompleter } from './repl/replCompleter.js';
import {
  printIdleHeader as renderIdleHeader,
  renderTurnStatusBar as renderReplStatusBar,
} from './repl/replSessionUi.js';


// ─── Local interactive/ modules (created during R6 decomposition) ────────────

import { type SessionState, type InteractiveTurn } from './types.js';
import * as Session from './session.js';
import * as Turn from './turns.js';
import { handleCommand } from './commands.js';
import { executeTask } from './execution/dispatch.js';
import { printRunSummary as printRunSummaryModule } from './execution/summary.js';
import { reverseHistorySearch } from './commands/service.js';
import { ChatEngine } from '../agent/chatEngine.js';
import { VoiceStreamManager } from '../voice/voice-stream-manager.js';
import type { PromptInputAdapter } from '../ui/promptInputAdapter.js';
import { OutputBuffer } from '../ui/outputBuffer.js';
import { installKeyHandler, type KeyEvent } from '../ui/keyInput.js';
import { planShellLayout } from '../ui/shell/shellLayout.js';
import { buildShellFrameInput } from '../ui/shell/shellPanels.js';
import { createShellHost, type ShellHost } from '../ui/shell/shellHost.js';
import { selectShellHost } from '../ui/shell/selectShellHost.js';
import {
  routeShellInput,
  shellInputLeaseActive,
  onShellSurfaceRelease,
  notifyShellSurfaceReleased,
  type ShellFocus,
  type ShellInputState,
} from '../ui/shell/shellInputRouter.js';
import { ShellRuntimeBinding } from '../ui/shell/shellRuntimeBinding.js';
import { projectShellPresentation } from '../ui/shell/shellPresentation.js';
import { ShellNavigator } from '../ui/shell/shellNavigation.js';
import { ShellSources } from '../ui/shell/shellSources.js';
import { ShellInspectorStore } from '../ui/shell/shellInspector.js';
import { getAvailableModels } from '../modelPolicy.js';
import {
  createShellCommandOperations,
  runShellCommand,
  type ShellCommandOperations,
} from '../ui/shell/shellOperations.js';
import { getActiveRenderer } from '../ui/waterfall.js';
import {
  isRendererPresentationSuspended,
  onRendererPresentationResume,
} from '../ui/rendererFence.js';

// ─── REPL Class ───────────────────────────────────────────────────────────────

export class BabelRepl {
  // Fields are public to satisfy the ReplContext interface used by extracted
  // modules. Previously private; test compatibility is preserved because
  // tests already set these directly via Object.create(BabelRepl.prototype).
  rl: readline.Interface;
  state: SessionState;
  isRunning: boolean = false;
  logBuffer: string[] = [];
  currentStageIdx: number = 0;
  verboseMode: boolean = false;
  lastRunDir: string | null = null;
  lastRunTranscript: string | null = null;
  readonly interactiveSessionId: string;
  readonly interactiveSessionDir: string;
  readonly interactiveTranscriptPath: string;
  turnCounter = 0;
  turns: InteractiveTurn[] = [];
  lastAssistantAnswer: string | null = null;
  lastAssistantNext: string | null = null;
  lastAssistantStatus: string | null = null;
  lastResolvedTask: string | null = null;
  lastSessionRunDir: string | null = null;
  warmedIndexRoots = new Set<string>();
  sessionIdentity: string | null = null;
  sessionIdentityRoot: string | null = null;
  lastTargetRoot: string | null = null;
  lastWorkspaceRoot: string | null = null;
  targetOverrideRoot: string | null = null;
  pasteBuffer: string[] = [];
  inPaste = false;
  projectSettingsApplied: boolean = false;
  screenManager: ScreenManager | undefined;
  chatEngine: ChatEngine | undefined = undefined;
  lastRoutingLabel: string | null = null;
  voiceManager: VoiceStreamManager | null = null;
  shellHost: ShellHost | undefined;
  shellRuntime: ShellRuntimeBinding | undefined;
  /** Epoch captured when the current executable shell turn was accepted. */
  private activeShellTurnEpoch: number | undefined;
  activeContext?: {
    tokens: number;
    modelId: string;
    source: 'provider_prompt_tokens' | 'estimated' | 'unknown';
  } | null;
  private shellKeyCleanup: (() => void) | null = null;
  private legacyKeypressHandler: ((str: string, key: rl.Key) => void) | null = null;
  private shellExclusiveRunnerCleanup: (() => void) | null = null;
  private legacyExclusiveDepth = 0;
  private pendingResponsiveResize: { rows: number; cols: number } | null = null;
  private unregisterResponsiveLeaseRelease: (() => void) | null = null;
  private unregisterResponsiveRendererResume: (() => void) | null = null;
  private startupHydrationComplete = false;
  private shellInputState: ShellInputState = {
    focus: 'composer',
    leftDrawerOpen: true,
    rightDrawerOpen: true,
  };
  /** Row cursor for the hosted shell; never the active-thread authority. */
  private readonly shellNavigator = new ShellNavigator();
  /** Cached real source projections (sessions/project/actions). */
  private readonly shellSources = new ShellSources();
  private shellModelChoices: { id: string; label: string }[] = [];
  /** Request-scoped inspector built from canonical session events. */
  private readonly shellInspector = new ShellInspectorStore();
  private shellInspectorCleanup: (() => void) | null = null;
  private shellCommandOperations: ShellCommandOperations | undefined;
  /** Cached target root so the frame path never probes the filesystem (U02). */
  private cachedTargetRoot: string | null = null;

  constructor(initialState?: Partial<SessionState>) {
    // Load saved history before creating the input interface
    const savedHistory = loadHistory();

    // Create input interface — uses PromptInput V2 by default on TTY.
    // Opt-out: set BABEL_PROMPT_V2=0 to force standard readline.
    // (Cast: createPromptInputAdapter returns node:readline.Interface,
    //  but BabelRepl uses node:readline/promises.Interface; both are
    //  compatible at runtime — the adapter supports callback + Promise paths.)
    this.rl = createPromptInputAdapter({
      input: process.stdin,
      output: process.stdout,
      prompt: dim('› '),
      historySize: 100,
      completer: (line: string) => buildReplCompleter(this)(line),
      history: savedHistory,
      onCommandPalette: () => {
        void this.openCommandPalette().catch(() => {});
      },
      onExternalEditor: () => this.handleExternalEditor(),
      isTaskRunning: () => this.isRunning,
      onVoiceToggle: () => this.toggleVoice(),
    }) as unknown as readline.Interface;
    registerReadlineInterface(this.rl);

    // Ctrl+R reverse history search
    this.legacyKeypressHandler = (_str: string, key: rl.Key) => {
      // The hosted shell has the sole live key-routing path. This listener is
      // retained only for legacy readline mode and must never double-deliver.
      if (this.shellHost || this.legacyExclusiveDepth > 0 || shellInputLeaseActive()) return;
      if ((key.name ?? '') === 'r' && key.ctrl) {
        void this.handleReverseSearch().catch(() => {});
      }
      if ((key.name ?? '') === 'p' && key.ctrl) {
        void this.openCommandPalette().catch(() => {});
      }
    };
    process.stdin.on('keypress', this.legacyKeypressHandler);

    // Start focus tracking so the render loop throttles when the terminal
    // Window loses focus. Keypress events are emitted by readline
    // after createPromptInputAdapter above calls emitKeypressEvents internally.
    FocusTracker.getInstance().start();

    // Inject persistent history for the standard readline fallback path.
    // (The PromptInput adapter receives history via the config above.)
    if (savedHistory.length > 0 && !shouldUsePromptInputV2()) {
      (this.rl as ReadlineWithHistory).history = savedHistory;
    }

    const detectedProject = initialState?.project ?? detectInitialProject();
    this.state = {
      mode: initialState?.mode ?? 'chat',
      ...(detectedProject !== undefined ? { project: detectedProject } : {}),
      router: 'v9',
      ...(initialState?.model !== undefined ? { model: initialState.model } : {}),
      lastRunUserStatus: initialState?.lastRunUserStatus ?? 'ready',
      lastRunTargetRoot: initialState?.lastRunTargetRoot ?? null,
      costTotals: initialState?.costTotals ?? {
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
      },
      turnCount: initialState?.turnCount ?? 0,
      ...(initialState?.lastAnswer !== undefined ? { lastAnswer: initialState.lastAnswer } : {}),
      ...(initialState?.lastTask !== undefined ? { lastTask: initialState.lastTask } : {}),
      ...(initialState?.lastRunDir !== undefined ? { lastRunDir: initialState.lastRunDir } : {}),
      ...(initialState?.timestamp !== undefined ? { timestamp: initialState.timestamp } : {}),
      ...(initialState?.projectRoot !== undefined ? { projectRoot: initialState.projectRoot } : {}),
    };

    if (this.state.model) {
      this.resolveSessionModel();
    }

    this.interactiveSessionId = `interactive_${new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 17)}`;
    this.interactiveSessionDir = path.join(
      BABEL_RUNS_DIR,
      'interactive-sessions',
      this.interactiveSessionId,
    );
    this.interactiveTranscriptPath = path.join(this.interactiveSessionDir, 'transcript.jsonl');
    fs.mkdirSync(this.interactiveSessionDir, { recursive: true });

    this.setupEventListeners();
  }

  private lastIdleHeaderResizeAt = 0;

  private setupEventListeners(): void {
    process.stdout.on('resize', () => {
      const rows = process.stdout.rows || 24;
      const cols = process.stdout.columns || 80;
      PaneManager.instance.onTerminalResize(rows, cols);
      const resizedLayout = planShellLayout({ cols, rows });
      const foreignSurfaceActive =
        SessionPicker.isActive() ||
        this.legacyExclusiveDepth > 0 ||
        shellInputLeaseActive();
      // A resize may arrive while a picker/editor/pager/approval owns stdin.
      // Defer host transitions until that lease has released.
      if (foreignSurfaceActive) {
        this.deferResponsiveResize(rows, cols);
        return;
      }
      if (this.shellHost && resizedLayout.mode === 'linear') {
        this.leaveNorthStarShell();
        const activeRenderer = getActiveRenderer() as unknown as {
          isRawModeActive?: () => boolean;
        } | null;
        // While a turn is running, the demoted renderer is the only legacy
        // stdin owner. Prompting here would install a second key handler.
        if (!this.isRunning || !activeRenderer?.isRawModeActive?.()) {
          try {
            this.rl.prompt();
          } catch {
            // The terminal may be tearing down; preserve the original resize path.
          }
        }
        return;
      }
      if (!this.shellHost && resizedLayout.mode !== 'linear') {
        this.startNorthStarShell();
        if (this.shellHost) return;
      }
      // Skip idle header while a task is running OR the resume picker owns the TTY.
      // isRunning alone is wrong here: during bootstrap/picker it is always false,
      // so Windows Terminal init resize events would inject the BABEL banner mid-picker.
      if (!this.isRunning && !SessionPicker.isActive()) {
        if (this.shellHost) {
          this.shellHost.invalidate('resize');
          return;
        }
        const now = Date.now();
        if (now - this.lastIdleHeaderResizeAt < 400) {
          return;
        }
        this.lastIdleHeaderResizeAt = now;
        const adapter = this.rl as unknown as {
          getInputText?: () => string;
          setInputText?: (text: string) => void;
        };
        preserveComposerAcrossResize(
          () => adapter.getInputText?.() ?? '',
          (text) => adapter.setInputText?.(text),
        );
        this.printIdleHeader();
      }
    });
    this.unregisterResponsiveLeaseRelease = onShellSurfaceRelease(() => {
      this.replayResponsiveResize();
    });
  }

  /**
   * Wire a ScreenManager instance so the /scrollback command can
   * access the scrollback buffer. Called by the Bootstrap or session
   * setup code that creates the ScreenManager.
   */
  setScreenManager(sm: ScreenManager): void {
    this.screenManager = sm;
  }

  public async start(): Promise<void> {
    await bootstrapReplSession(this, () => BabelRepl.loadSessionState());
    await maybeShowResumePicker(this);
    this.startupHydrationComplete = true;
    this.startNorthStarShell();
    this.replayResponsiveResize();
    await runReplLoop(this, { executeTask: (input) => this.executeTask(input) });
  }

  private startNorthStarShell(): void {
    // Startup resume-picker release notifications can replay a resize before
    // start() reaches its normal host initialization call. Treat promotion as
    // idempotent so that path cannot install a second stdin handler or replace
    // the cleanup handles for the already-mounted host.
    if (this.shellHost) return;
    const selection = selectShellHost();
    if (selection.host !== 'north_star') return;

    const adapter = this.rl as unknown as PromptInputAdapter;
    if (
      typeof adapter.setPresentationTarget !== 'function' ||
      typeof adapter.getView !== 'function' ||
      typeof adapter.processKey !== 'function'
    ) {
      return;
    }

    // A resize can promote a running legacy turn into North Star after Chat
    // already installed ConversationalRenderer raw input. Transfer ownership
    // before the hosted prompt is activated so the shell has one stdin path.
    const activeRenderer = getActiveRenderer() as unknown as {
      setInputOwnership?: (ownsInput: boolean) => void;
    } | null;
    activeRenderer?.setInputOwnership?.(false);

    let host: ShellHost | undefined;
    const threadId = this.chatEngine?.getEngineRunId();
    this.shellRuntime = new ShellRuntimeBinding({
      ...(threadId !== undefined ? { threadId } : {}),
      width: Math.max(1, OutputBuffer.getTerminalSize().cols),
      onChange: () => {
        host?.invalidate('runtime-event');
      },
    });
    this.shellRuntime.hydrateTurns(this.turns, threadId);
    this.shellInspector.setActiveSession(threadId);
    this.cachedTargetRoot = this.resolveCurrentTarget().targetRoot;
    this.shellSources.ensureProjectRoot(this.cachedTargetRoot);
    try {
      this.shellModelChoices = getAvailableModels()
        .slice(0, 8)
        .map((model) => ({ id: model.key, label: model.key }));
    } catch {
      this.shellModelChoices = [];
    }
    const frameSource = () => {
      const dimensions = OutputBuffer.getTerminalSize();
      const layout = planShellLayout(dimensions);
      const promptRect = layout.composer ?? {
        x: 0,
        y: Math.max(0, layout.rows - 3),
        width: layout.effectiveCols,
        height: 3,
      };
      const prompt = adapter.getView(promptRect);
      const presentation = projectShellPresentation(
        layout,
        this.shellInputState,
        this.shellNavigator.getSelection(),
      );
      this.shellInputState = presentation.inputState;
      const conversation = this.shellRuntime
        ? this.shellRuntime.getVisibleRows(
            Math.max(1, layout.conversationText?.width ?? layout.center?.width ?? 1),
            Math.max(0, layout.conversationText?.height ?? layout.conversation?.height ?? 0),
          )
        : [];
      const runtime = this.shellRuntime?.getSnapshot();
      if (runtime?.threadId !== this.shellInspector.getActiveSessionId()) {
        this.shellInspector.setActiveSession(runtime?.threadId);
      }
      const sources = this.shellSources.snapshot();
      this.shellNavigator.setRows('sessions', sources.sessions);
      this.shellNavigator.setRows('project', sources.projectRows);
      this.shellNavigator.setRows('actions', sources.actions);
      const modeRows = (['chat', 'plan', 'deep'] as const).map((mode) => ({
        id: mode,
        label: mode,
        command: { kind: 'mode.set' as const, mode },
      }));
      const modelRows = this.shellModelChoices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        command: { kind: 'model.set' as const, model: choice.id },
      }));
      this.shellNavigator.setRows('inspector', [...modeRows, ...modelRows]);
      const inspector = this.shellInspector.build({
        selectedModel: this.state.resolvedModelId ?? this.state.model ?? 'auto',
        sessionTokens: this.activeContext
          ? { tokens: this.activeContext.tokens, source: this.activeContext.source }
          : null,
      });
      const activity = runtime?.activity ?? (this.isRunning ? 'running' : 'idle');
      const sessionLabels =
        sources.sessionStatus === 'error'
          ? ['Session list unavailable']
          : sources.sessionStatus === 'loading'
            ? ['Loading sessions…']
            : sources.sessions.map((row) => row.label);
      return buildShellFrameInput(layout, {
        mode: this.state.mode,
        model: this.state.resolvedModelId ?? this.state.model ?? 'auto',
        project: this.state.project ?? 'global',
        conversation,
        sessions: sessionLabels,
        projectRows:
          sources.projectRows.length > 0
            ? sources.projectRows.map((row) => row.label)
            : [sources.projectRoot || this.cachedTargetRoot || 'unknown target'],
        actions: sources.actions.map((row) => row.label),
        modelChoices: this.shellModelChoices,
        clock: new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        tools: inspector.tools,
        toolStates: inspector.toolStates,
        context: inspector.context,
        meter: inspector.meter,
        status: [
          activity === 'idle' ? 'Ready' : activity,
          ...(runtime?.lastOutcome ? [`Last outcome: ${runtime.lastOutcome}`] : []),
        ],
        ...(prompt ? { prompt } : {}),
        presentation,
      });
    };

    host = createShellHost({ frameSource, componentId: 'babel-north-star-shell' });
    this.shellCommandOperations = createShellCommandOperations(this, {
      invalidate: (reason) => host?.invalidate(reason),
      onSessionChanged: (changedThreadId) => this.rebindShellRuntime(changedThreadId),
      onProjectToggle: (root) => this.shellSources.toggleDirectory(root),
    });
    this.shellInspectorCleanup = this.shellInspector.attach(() =>
      host?.invalidate('session-event'),
    );
    void this.shellSources
      .refreshSessions()
      .then(() => host?.invalidate('sessions-loaded'))
      .catch(() => {});
    adapter.setPresentationTarget({
      getRect: () => {
        const layout = planShellLayout(OutputBuffer.getTerminalSize());
        return layout.composer ?? {
          x: 0,
          y: Math.max(0, layout.rows - 3),
          width: layout.effectiveCols,
          height: 3,
        };
      },
      invalidate: (reason) => host?.invalidate(reason),
    });
    this.shellHost = host;
    this.shellExclusiveRunnerCleanup = registerExclusiveTerminalRunner((reason, work) =>
      this.withExclusiveTerminal(reason, work),
    );
    this.shellKeyCleanup = installKeyHandler(process.stdin, (event: KeyEvent) => {
      this.dispatchShellKey(event, host, adapter);
    });
    host.mount();
    // Responsive promotion may happen while the legacy prompt is inactive
    // because the current renderer owns raw input. Re-activate the hosted
    // editor without installing another stdin reader.
    adapter.prompt();
  }

  private leaveNorthStarShell(): void {
    const adapter = this.rl as unknown as PromptInputAdapter & {
      setPresentationTarget?: (target: null) => void;
    };
    const activeRenderer = getActiveRenderer() as unknown as {
      setInputOwnership?: (ownsInput: boolean) => void;
      isRawModeActive?: () => boolean;
    } | null;
    const promptInput = adapter.getPromptInput?.();
    const rendererWillOwnInput = Boolean(
      activeRenderer?.setInputOwnership &&
      (this.isRunning || activeRenderer.isRawModeActive?.()),
    );
    // setPresentationTarget(null) restores PromptInput's standalone reader.
    // During a running responsive demotion that reader must stay inactive until
    // renderer ownership is restored, otherwise both receive the same bytes.
    if (rendererWillOwnInput && promptInput?.getState().active) {
      promptInput.deactivate();
    }
    adapter.setPresentationTarget?.(null);
    this.shellKeyCleanup?.();
    this.shellKeyCleanup = null;
    this.shellHost?.dispose();
    this.shellHost = undefined;
    this.shellExclusiveRunnerCleanup?.();
    this.shellExclusiveRunnerCleanup = null;
    this.shellRuntime = undefined;
    this.activeShellTurnEpoch = undefined;
    this.shellInspectorCleanup?.();
    this.shellInspectorCleanup = null;
    this.shellCommandOperations = undefined;
    this.cachedTargetRoot = null;
    if (rendererWillOwnInput) activeRenderer?.setInputOwnership?.(true);
  }

  /**
   * Route one key through the hosted shell and apply the resulting action.
   *
   * Kept as an explicit method (rather than an inline closure) so the
   * move/activate invariant is testable against this exact handler path.
   */
  private dispatchShellKey(
    event: KeyEvent,
    host: ShellHost | undefined,
    adapter: PromptInputAdapter,
    layout: ReturnType<typeof planShellLayout> = planShellLayout(OutputBuffer.getTerminalSize()),
  ): void {
    this.shellInputState = projectShellPresentation(layout, this.shellInputState).inputState;
    const routed = routeShellInput(event, this.shellInputState);
    this.shellInputState = routed.state;
    this.shellNavigator.setFocus(routed.state.focus);
    if (routed.action === 'move-selection') {
      // Cursor-only: never changes the active thread.
      this.shellNavigator.move(routed.state.focus, event.name);
      host?.invalidate('move-selection');
      return;
    }
    if (routed.action === 'activate-selection') {
      void this.activateShellSelection(routed.state.focus, host).catch(() => {});
      return;
    }
    if (routed.action === 'open-palette') {
      void this.openCommandPalette().catch(() => {});
    }
    if (routed.action === 'open-reverse-search') {
      void this.handleReverseSearch().catch(() => {});
    }
    if (routed.action === 'focus-changed' || routed.action === 'close-overlay') {
      host?.invalidate(routed.action);
    }
    if (!routed.handled && routed.state.focus === 'composer') adapter.processKey(event);
  }

  /**
   * Rebind the presentation runtime to a new active thread after a real
   * session operation. The navigator's row cursor is intentionally untouched:
   * the active thread and the selected row are separate state.
   */
  private rebindShellRuntime(threadId: string | undefined): void {
    if (this.shellRuntime) this.shellRuntime.hydrateTurns(this.turns, threadId);
    // The inspector is request-scoped: on a session/target transition it must
    // drop any buffered prior-session facts and scope to the new active session.
    this.shellInspector.setActiveSession(threadId);
    this.shellInspector.reset();
    this.shellHost?.invalidate('session-changed');
  }

  /** Resolve and execute the selected row's real operation. */
  private async activateShellSelection(
    surface: ShellFocus,
    host: ShellHost | undefined,
  ): Promise<void> {
    const command = this.shellNavigator.activate(surface);
    const operations = this.shellCommandOperations;
    if (command.kind === 'none' || !operations) {
      host?.invalidate('activate-noop');
      return;
    }
    await this.withExclusiveTerminal(`shell-${command.kind}`, () =>
      runShellCommand(command, operations),
    );
    if (
      command.kind === 'session.resume' ||
      command.kind === 'session.new' ||
      command.kind === 'target.set'
    ) {
      const root = this.targetOverrideRoot ?? this.resolveCurrentTarget().targetRoot;
      this.cachedTargetRoot = root;
      this.shellSources.ensureProjectRoot(root);
      await this.shellSources.refreshSessions().catch(() => {});
    }
    host?.invalidate('shell-activation');
  }

  // ── Session Persistence ──────────────────────────────────────────────────

  saveSessionState(): void {
    Session.saveSessionState(this);
  }
  static loadSessionState(): SessionState | null {
    return Session.loadSessionState();
  }

  printIdleHeader(): void {
    if (this.shellHost) {
      this.shellHost.invalidate('idle-header');
      return;
    }
    renderIdleHeader(this);
  }

  renderTurnStatusBar(): void {
    if (this.shellHost) {
      this.shellHost.invalidate('status-bar');
      return;
    }
    renderReplStatusBar(this);
  }

  // ── Command router ────────────────────────────────────────────────────────

  private async handleCommand(input: string): Promise<void> {
    return handleCommand(this, input);
  }

  // ── Turn tracking ────────────────────────────────────────────────────────

  appendTurn(
    turn: Omit<InteractiveTurn, 'schema_version' | 'turn_id' | 'ts'>,
    shellOutcome?: string,
  ): InteractiveTurn {
    const record = Turn.appendTurn(this, turn);
    if (record.role === 'assistant') {
      this.shellRuntime?.observeInteractiveTurn(
        record,
        shellOutcome,
        this.activeShellTurnEpoch ?? this.shellRuntime.store.epoch,
      );
    }
    return record;
  }

  beginShellTurn(turnId: number, input: string): void {
    this.shellRuntime?.beginTurn(turnId, input, this.chatEngine?.getEngineRunId());
    this.activeShellTurnEpoch = this.shellRuntime?.store.epoch;
  }

  // ── Test-only wrappers (accessed via Object.create(BabelRepl.prototype) in interactive.test.ts) ──

  /** @test-only — accessed via prototype in interactive.test.ts */
  private resolveInteractiveTask(input: string): string {
    return Turn.resolveInteractiveTask(this, input);
  }

  /** @test-only — accessed via prototype in interactive.test.ts */
  private classifyInteractiveLane(input: string): ReturnType<typeof Turn.classifyInteractiveLane> {
    return Turn.classifyInteractiveLane(this, input);
  }

  // ── Target resolution ────────────────────────────────────────────────────

  resolveCurrentTarget(): AgentTargetContext {
    return resolveAgentTarget({
      ...(this.state.project !== undefined ? { project: this.state.project } : {}),
      ...(this.targetOverrideRoot ? { projectRoot: this.targetOverrideRoot } : {}),
    });
  }

  scheduleIndexWarmup(projectRoot: string): void {
    if (this.warmedIndexRoots.has(projectRoot)) {
      return;
    }
    this.warmedIndexRoots.add(projectRoot);
    startLiteIndexWarmup(projectRoot);
  }

  // ── Session Model Resolution ──────────────────────────────────────────────

  resolveSessionModel(): void {
    Session.resolveSessionModel(this);
  }

  // ── Task Execution ────────────────────────────────────────────────────────

  private async executeTask(input: string): Promise<void> {
    try {
      return await executeTask(this, input);
    } catch (err: any) {
      this.isRunning = false;
      // Skip if an inner boundary (governed/plan/chat) already showed a dialog
      if (err[Symbol.for('babel.error.alerted')]) return;
      const message = err instanceof Error ? err.message : String(err);
      if (process.stdout.isTTY && !process.env['CI']) {
        try {
          await this.withExclusiveTerminal('error-alert', () =>
            alert({
              title: 'Execution Error',
              message: `A fatal error occurred during execution:\n\n${message}`,
            }),
          );
        } catch {
          // alert() itself failed — fall back to console
          console.error(`\nExecution Error: ${message}\n`);
        }
      } else {
        console.error(`\nExecution Error: ${message}\n`);
      }
    }
  }

  // ── Run Summary (test-only wrapper) ───────────────────────────────────────

  /** @test-only — accessed via prototype in interactive.test.ts */
  private printRunSummary(
    result: any,
    context: { input?: string; task: string; projectRoot?: string; transcript?: string },
  ): void {
    printRunSummaryModule(this, result, context);
  }

  // ── External editor (Ctrl+G) ───────────────────────────────────────────────

  private async handleExternalEditor(): Promise<void> {
    const adapter = this.rl as readline.Interface & {
      getInputText?: () => string;
      setInputText?: (text: string) => void;
    };
    const seed = adapter.getInputText?.() ?? '';
    const edited = await this.withExclusiveTerminal('external-editor', () =>
      openEditor({
        rl: this.rl,
        ...(seed ? { seed } : {}),
      }),
    );
    if (edited != null) {
      adapter.setInputText?.(edited);
    }
  }

  // ── Voice Dictation ──────────────────────────────────────────────────────

  /** Toggle voice dictation on/off (Ctrl+Shift+V hotkey).
   *  @returns true if the hotkey was consumed, false to pass through. */
  private toggleVoice(): boolean {
    // Lazily initialise voice system on first use
    if (process.env['BABEL_VOICE_ENABLED'] !== '1') {
      console.debug('[BabelRepl] Voice dictation disabled — set BABEL_VOICE_ENABLED=1 to enable');
      return false;
    }

    if (!this.voiceManager) {
      this.voiceManager = new VoiceStreamManager();
    }

    if (this.voiceManager.isActive()) {
      this.voiceManager.stopCapture().catch((err: unknown) => {
        console.error('[BabelRepl] Voice stop error:', err);
      });
    } else {
      // Access the underlying PromptInput via the adapter interface
      const adapter = this.rl as unknown as PromptInputAdapter;
      const promptInput = adapter.getPromptInput?.() ?? null;
      if (promptInput) {
        this.voiceManager.startCapture(promptInput).catch((err: unknown) => {
          console.error('[BabelRepl] Voice start error:', err);
        });
      } else {
        console.warn('[BabelRepl] Voice dictation unavailable — PromptInput adapter not found');
        return false;
      }
    }
    return true;
  }

  // ── Command Palette ──────────────────────────────────────────────────────

  private async openCommandPalette(): Promise<void> {
    await this.withExclusiveTerminal('command-palette', () => CommandPalette.show(this));
    this.printIdleHeader();
  }

  // ── Exit ─────────────────────────────────────────────────────────────────

  private async handleReverseSearch(): Promise<void> {
    const history = (this.rl as ReadlineWithHistory).history;
    await this.withExclusiveTerminal('reverse-history', () =>
      reverseHistorySearch(this.rl, history),
    );
  }

  settleShellTurn(outcome?: string, sourceEpoch?: number): void {
    this.shellRuntime?.settleTurn(outcome, sourceEpoch);
    if (this.shellRuntime?.store.turnId === undefined) this.activeShellTurnEpoch = undefined;
  }

  async withExclusiveTerminal<T>(reason: string, work: () => Promise<T>): Promise<T> {
    if (!this.shellHost) {
      this.legacyExclusiveDepth += 1;
      try {
        return await withExclusiveStdin(work, this.rl);
      } finally {
        this.legacyExclusiveDepth = Math.max(0, this.legacyExclusiveDepth - 1);
        notifyShellSurfaceReleased();
      }
    }
    const adapter = this.rl as unknown as PromptInputAdapter;
    return this.shellHost.withExclusiveTerminal(reason, async () => {
      const resumeInput = adapter.suspendInput?.();
      try {
        return await work();
      } finally {
        resumeInput?.();
      }
    });
  }

  private deferResponsiveResize(rows: number, cols: number): void {
    this.pendingResponsiveResize = { rows, cols };
    if (!this.unregisterResponsiveRendererResume && isRendererPresentationSuspended()) {
      this.unregisterResponsiveRendererResume = onRendererPresentationResume(() => {
        this.unregisterResponsiveRendererResume = null;
        this.replayResponsiveResize();
      });
    }
  }

  private replayResponsiveResize(): void {
    const pending = this.pendingResponsiveResize;
    if (!pending) return;
    if (!this.startupHydrationComplete) return;
    if (
      SessionPicker.isActive() ||
      this.legacyExclusiveDepth > 0 ||
      shellInputLeaseActive() ||
      isRendererPresentationSuspended()
    ) {
      return;
    }

    this.pendingResponsiveResize = null;
    this.unregisterResponsiveLeaseRelease?.();
    this.unregisterResponsiveLeaseRelease = null;
    this.unregisterResponsiveRendererResume?.();
    this.unregisterResponsiveRendererResume = null;

    const resizedLayout = planShellLayout({ cols: pending.cols, rows: pending.rows });
    if (this.shellHost && resizedLayout.mode === 'linear') {
      this.leaveNorthStarShell();
      const activeRenderer = getActiveRenderer() as unknown as {
        isRawModeActive?: () => boolean;
      } | null;
      if (!this.isRunning || !activeRenderer?.isRawModeActive?.()) {
        try {
          this.rl.prompt();
        } catch {
          // The terminal may be tearing down.
        }
      }
      return;
    }
    if (!this.shellHost && resizedLayout.mode !== 'linear') {
      this.startNorthStarShell();
    }
  }

  exit(): void {
    if (this.legacyKeypressHandler) {
      process.stdin.off('keypress', this.legacyKeypressHandler);
      this.legacyKeypressHandler = null;
    }
    this.shellKeyCleanup?.();
    this.shellKeyCleanup = null;
    this.shellHost?.dispose();
    this.shellHost = undefined;
    this.shellExclusiveRunnerCleanup?.();
    this.shellExclusiveRunnerCleanup = null;
    this.shellRuntime = undefined;
    this.activeShellTurnEpoch = undefined;
    this.shellInspectorCleanup?.();
    this.shellInspectorCleanup = null;
    this.shellCommandOperations = undefined;
    this.cachedTargetRoot = null;
    exitRepl();
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

export async function startInteractiveSession(initialState?: Partial<SessionState>): Promise<void> {
  const { startTuiObservation, writeTuiSessionRef, stopTuiObservation } = await import(
    '../ui/observe/observeSession.js'
  );
  const sessionDir = startTuiObservation();
  const repl = new BabelRepl(initialState);
  if (sessionDir) writeTuiSessionRef(repl.interactiveSessionDir, sessionDir);
  try {
    await repl.start();
  } finally {
    stopTuiObservation();
  }
}
