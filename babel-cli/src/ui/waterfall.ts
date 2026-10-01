import { error } from './theme.js';
import { isA11yMode, a11yActivityEvent } from './a11y.js';
import { StateStore, type TuiMutation, type TuiState } from './stateMutationBus.js';
import { conversationalToolLabel } from './toolDisplay.js';
import {
  BaseRenderer,
  activityKey,
  formatElapsed,
  normalizeActivityLine,
  runtimeEventLabel,
  safeStdoutWrite,
  stageAction,
  type EventBus,
  type RendererContext,
  type RuntimeEvent,
} from './rendererSupport.js';
import { ConversationalRenderer } from './conversationalRenderer.js';
export { getActiveRenderer } from './rendererSupport.js';
export { WaterfallRenderer } from './waterfallRenderer.js';
export { successLike } from './rendererSupport.js';
export { formatElapsed } from './rendererSupport.js';
export { formatDuration } from './rendererSupport.js';
export { formatETA } from './rendererSupport.js';
export { stageAction } from './rendererSupport.js';
export { renderErrorBox } from './rendererSupport.js';
export { activityKey } from './rendererSupport.js';
export { normalizeActivityLine } from './rendererSupport.js';
export { activityColor } from './rendererSupport.js';
export { runtimeEventLabel } from './rendererSupport.js';
export { TtyHudRenderer } from './waterfallRenderer.js';
export { ConversationalRenderer } from './conversationalRenderer.js';

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
