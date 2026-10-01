import {
  accentBright,
  muted,
  dim,
  info,
  success,
  error,
  warning,
  getTerminalWidth,
  visibleLength,
  wrapText,
} from './theme.js';
import { OutputBuffer, isBrokenStdoutError } from './outputBuffer.js';
import { isRendererPresentationSuspended, registerRendererFenceTarget } from './rendererFence.js';



export const SPINNER_FRAMES: readonly string[] = ['◐', '◓', '◑', '◒'];


export const FRAME_INTERVAL_MS = 200;

// 5 FPS spinner tick

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
export function safeStdoutWrite(text: string): boolean {
  const buf = OutputBuffer.getInstance();
  if (!buf.canWrite) return false;
  // Foreign terminal surfaces (approval dialogs, editors, pagers, and
  // palettes) own the terminal while they are active. Runtime event handlers
  // may continue updating renderer state, but their direct presentation must
  // not race the exclusive surface's output.
  if (isRendererPresentationSuspended()) return true;
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

/**
 * Apply the shared exclusive-terminal fence to the currently active run
 * renderer. The returned release is idempotent and supports nested callers.
 */
// ── Interfaces ───────────────────────────────────────────────────────────────
export interface EventBus {
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}


export interface RendererContext {
  mode?: string | undefined;
  task?: string | undefined;
  targetProject?: string | undefined;
  project?: string | undefined;
  projectRoot?: string | undefined;
}


export interface RuntimeEvent {
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


export interface SummaryOptions {
  status?: string | undefined;
  costUSD?: number | undefined;
  changedFiles?: unknown;
  perRunCost?: number | undefined;
}

/**
 * Base renderer providing shared EPIPE guard, output-broken flag, and
 * active-instance tracking. All concrete renderers extend this.
 */
export class BaseRenderer {
  protected outputBroken: boolean;
  private removeStdoutErrorGuard: (() => void) | undefined;
  protected _onBrokenPipe: () => void;
  private exclusiveSurfaceDepth = 0;
  private exclusiveSurfaceRawModeWasActive = false;
  private unregisterRendererFence: (() => void) | null = null;

  constructor() {
    activeRendererInstance = this;
    this.unregisterRendererFence = registerRendererFenceTarget(this);
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

  /** Whether this renderer currently owns a raw-mode input handler. */
  isRawModeActive(): boolean {
    return false;
  }

  /** Transfer raw-input ownership when the host changes responsively. */
  setInputOwnership(_ownsInput: boolean): void {}

  /**
   * Suspend renderer presentation and raw input while a foreign terminal
   * surface owns the TTY. Nested leases are balanced at this boundary.
   */
  suspendForExclusiveSurface(): () => void {
    this.exclusiveSurfaceDepth += 1;
    if (this.exclusiveSurfaceDepth === 1) {
      this.pauseTicks();
      this.exclusiveSurfaceRawModeWasActive = this.isRawModeActive();
      if (this.exclusiveSurfaceRawModeWasActive) this.disableRawMode();
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exclusiveSurfaceDepth = Math.max(0, this.exclusiveSurfaceDepth - 1);
      if (this.exclusiveSurfaceDepth !== 0) return;

      this.resumeTicks();
      if (this.exclusiveSurfaceRawModeWasActive) this.enableRawMode();
      this.exclusiveSurfaceRawModeWasActive = false;
    };
  }

  // Concrete renderers with terminal input override these hooks.
  enableRawMode(): void {}
  disableRawMode(): void {}

  destroy(): void {
    this.removeStdoutErrorGuard?.();
    this.unregisterRendererFence?.();
    this.unregisterRendererFence = null;
    if (activeRendererInstance === this) activeRendererInstance = null;
  }

  // note: the _pausedTicks field below is read by overrides in subclasses
  // that use a differently-named `pausedTicks` (no underscore). This base
  // declaration preserves the original JS shape exactly.
  protected _pausedTicks: boolean | undefined = undefined;
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
