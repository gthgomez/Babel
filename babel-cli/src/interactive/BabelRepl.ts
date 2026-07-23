import * as readline from 'node:readline/promises';
import * as rl from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ReadlineWithHistory extends readline.Interface {
  history: string[];
}
import { dim } from '../ui/theme.js';
import { registerReadlineInterface } from '../ui/inputCoordinator.js';
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
    process.stdin.on('keypress', (_str: string, key: rl.Key) => {
      if ((key.name ?? '') === 'r' && key.ctrl) {
        void this.handleReverseSearch();
      }
      if ((key.name ?? '') === 'p' && key.ctrl) {
        void this.openCommandPalette().catch(() => {});
      }
    });

    // Start focus tracking so the render loop throttles when the terminal
    // window loses focus (R4.7). Keypress events are emitted by readline
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

  private setupEventListeners(): void {
    process.stdout.on('resize', () => {
      const rows = process.stdout.rows || 24;
      const cols = process.stdout.columns || 80;
      PaneManager.instance.onTerminalResize(rows, cols);
      // Skip idle header while a task is running OR the resume picker owns the TTY.
      // isRunning alone is wrong here: during bootstrap/picker it is always false,
      // so Windows Terminal init resize events would inject the BABEL banner mid-picker.
      if (!this.isRunning && !SessionPicker.isActive()) {
        this.printIdleHeader();
      }
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
    await runReplLoop(this, { executeTask: (input) => this.executeTask(input) });
  }

  // ── Session Persistence ──────────────────────────────────────────────────

  saveSessionState(): void {
    Session.saveSessionState(this);
  }
  static loadSessionState(): SessionState | null {
    return Session.loadSessionState();
  }

  printIdleHeader(): void {
    renderIdleHeader(this);
  }

  renderTurnStatusBar(): void {
    renderReplStatusBar(this);
  }

  // ── Command router ────────────────────────────────────────────────────────

  private async handleCommand(input: string): Promise<void> {
    return handleCommand(this, input);
  }

  // ── Turn tracking ────────────────────────────────────────────────────────

  appendTurn(turn: Omit<InteractiveTurn, 'schema_version' | 'turn_id' | 'ts'>): InteractiveTurn {
    return Turn.appendTurn(this, turn);
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
          await alert({
            title: 'Execution Error',
            message: `A fatal error occurred during execution:\n\n${message}`,
          });
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
    const edited = await openEditor({
      rl: this.rl,
      ...(seed ? { seed } : {}),
    });
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
    await CommandPalette.show(this);
    this.printIdleHeader();
  }

  // ── Exit ─────────────────────────────────────────────────────────────────

  private async handleReverseSearch(): Promise<void> {
    const history = (this.rl as ReadlineWithHistory).history;
    await reverseHistorySearch(this.rl, history);
  }

  exit(): void {
    exitRepl();
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

export async function startInteractiveSession(initialState?: Partial<SessionState>): Promise<void> {
  const repl = new BabelRepl(initialState);
  await repl.start();
}
