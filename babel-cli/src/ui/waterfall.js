import logUpdate from 'log-update';
import { 
    accentBright, activeAccent, border, muted, primary, dim, bold, commandAccent, info, sectionLabel,
    getTerminalWidth, padRight 
} from './theme.js';
import { globalCostTracker } from '../services/costTracker.js';

const BROKEN_STDOUT_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ENOTCONN']);

function isBrokenStdoutError(error) {
    return BROKEN_STDOUT_CODES.has(error?.code);
}

function safeStdoutWrite(text) {
    try {
        process.stdout.write(text);
        return true;
    } catch (error) {
        return !isBrokenStdoutError(error);
    }
}

function safeLogUpdate(text) {
    try {
        logUpdate(text);
        return true;
    } catch (error) {
        return !isBrokenStdoutError(error);
    }
}

function safeLogUpdateDone() {
    try {
        logUpdate.done();
        return true;
    } catch (error) {
        return !isBrokenStdoutError(error);
    }
}

function installStdoutErrorGuard(onBrokenPipe) {
    const handler = (error) => {
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

/**
 * Professional live HUD for Babel.
 * Manages a reactive coding-agent view during pipeline execution.
 */
export class WaterfallRenderer {
    constructor(eventBus, context = {}) {
        this.outputBroken = false;
        this.removeStdoutErrorGuard = installStdoutErrorGuard(() => {
            this.outputBroken = true;
            clearInterval(this.timer);
        });
        this.context = context;
        this.currentStage = 0;
        this.statusLines = [];
        this.transcriptLines = [];
        this.startTime = Date.now();
        this.lastMeaningfulEventAt = this.startTime;
        this.waitingLineAdded = false;
        this.thinking = false;
        this.thinkingFrame = 0;
        this.activityKeys = new Set();
        this.activeFiles = [];
        this.activeAction = 'Starting Babel';
        this.paused = false;
        this.frames = ['◐', '◓', '◑', '◒'];

        eventBus.on('stage', (index) => {
            if (this.paused) return;
            this.currentStage = index;
            this.thinking = false;
            this.activeAction = stageAction(index);
            this.recordActivity(this.activeAction);
            this.render();
        });

        eventBus.on('agent_id', (id) => {
            if (this.paused) return;
            this.agentId = id;
            this.render();
        });

        eventBus.on('log', (line) => {
            if (this.paused) return;
            const normalized = normalizeActivityLine(line);
            if (!normalized) {
                return;
            }
            if (/thinking|planning|reasoning/i.test(normalized)) {
                this.thinking = true;
            }
            const fileMatch = normalized.match(/\b(?:reading|writing|editing|patched|file)\b[:\s]+([^\s]+)/i);
            if (fileMatch?.[1]) {
                const file = fileMatch[1].replace(/["']/g, '');
                if (!this.activeFiles.includes(file)) {
                    this.activeFiles.unshift(file);
                    if (this.activeFiles.length > 3) this.activeFiles.pop();
                }
            }
            this.activeAction = normalized;
            this.recordActivity(normalized);
            this.render();
        });

        eventBus.on('runtime_event', (event) => {
            if (this.paused) return;
            const label = runtimeEventLabel(event);
            if (label) {
                this.activeAction = label;
                this.recordActivity(label);
            }
            if (event?.event_type === 'verification.decision') {
                this.currentStage = Math.max(this.currentStage, 5);
            }
            this.render();
        });

        this.timer = setInterval(() => {
            if (this.paused) return;
            this.thinkingFrame = (this.thinkingFrame + 1) % this.frames.length;
            this.updateWaitingState();
            this.render();
        }, 1000);

        eventBus.on('prompt_pause', (label) => this.pauseForPrompt(label));
        eventBus.on('prompt_resume', () => this.resume());
    }

    start() {
        this.render();
    }

    stop() {
        clearInterval(this.timer);
        safeLogUpdateDone();
        safeStdoutWrite('\u001B[?25h');
        this.removeStdoutErrorGuard?.();
    }

    fail() {
        this.stop();
        safeStdoutWrite('\u001B[?25h');
    }

    pauseForPrompt(label = 'Waiting for user input') {
        this.paused = true;
        this.activeAction = String(label);
        this.recordActivity(String(label));
        safeLogUpdateDone();
        safeStdoutWrite('\u001B[?25h');
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        safeStdoutWrite('\u001B[?25l');
        this.render();
    }

    recordActivity(line) {
        const key = activityKey(line);
        if (!line || this.activityKeys.has(key)) {
            return;
        }
        this.activityKeys.add(key);
        this.lastMeaningfulEventAt = Date.now();
        this.waitingLineAdded = false;
        this.statusLines.push(line);
        if (this.statusLines.length > 5) this.statusLines.shift();
        this.transcriptLines.push(`[${formatElapsed(this.lastMeaningfulEventAt - this.startTime)}] ${line}`);
    }

    updateWaitingState() {
        if (this.waitingLineAdded || Date.now() - this.lastMeaningfulEventAt < 30_000) {
            return;
        }
        const waiting = this.currentStage >= 4 ? 'Waiting for command output' : 'Waiting for plan approval';
        this.waitingLineAdded = true;
        this.activeAction = waiting;
        this.statusLines.push(waiting);
        if (this.statusLines.length > 5) this.statusLines.shift();
        this.transcriptLines.push(`[${formatElapsed(Date.now() - this.startTime)}] ${waiting}`);
    }

    getTranscript() {
        return this.transcriptLines.join('\n');
    }

    render() {
        if (this.paused) return;
        if (this.outputBroken) return;
        const width = getTerminalWidth();
        const elapsed = formatElapsed(Date.now() - this.startTime);
        const stats = globalCostTracker.getSessionSummary();
        const costStr = stats.totalCostUSD.toFixed(4);

        const stageLabels = ['Route', 'Plan', 'Review', 'Apply', 'Verify'];
        const progress = stageLabels.map((label, i) => {
            const index = i + 1;
            if (index < this.currentStage) return successLike('● ' + label);
            if (index === this.currentStage) {
                const prefix = this.thinking ? activeAccent(this.frames[this.thinkingFrame]) : activeAccent('◐');
                return bold(`${prefix} ${activeAccent(label)}`);
            }
            return dim('○ ' + label);
        }).join(muted('   '));

        const titleParts = [
            'Babel Run',
            'dusk',
            this.currentStage >= 5 ? 'verified' : 'working',
            this.context.executionProfile ?? this.context.mode,
        ].filter(Boolean);

        const hud = [
            sectionLabel(titleParts.join(' · ')),
            border('━'.repeat(width)),
            progress,
            '',
            sectionLabel('Working:'),
            `  ${primary(this.activeAction)}`,
            ...(this.statusLines.length > 0 ? [
                '',
                sectionLabel('Activity:'),
                ...this.statusLines.slice(-5).map(line => `  ${muted(line)}`),
            ] : []),
            ...(this.activeFiles.length > 0 ? [
                '',
                sectionLabel('Files:'),
                `  ${this.activeFiles.map(f => info(f)).join(muted(', '))}`,
            ] : []),
            '',
            `${muted('Time')} ${elapsed}   ${muted('Cost')} ${commandAccent(`$${costStr}`)}`,
            border('━'.repeat(width)),
        ].join('\n');

        if (!safeLogUpdate(hud)) {
            this.outputBroken = true;
            clearInterval(this.timer);
        }
    }
}

function successLike(text) {
    return accentBright(text);
}

function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function stageAction(index) {
    if (index === 1) return 'Routing request';
    if (index === 2) return 'Planning change';
    if (index === 3) return 'Reviewing plan';
    if (index === 4) return 'Applying change';
    if (index === 5) return 'Verifying result';
    return 'Working';
}

function activityKey(line) {
    return String(line ?? '')
        .toLowerCase()
        .replace(/\d+\s*\/\s*\d+/g, '#/#')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeActivityLine(line) {
    const text = String(line ?? '').trim();
    if (!text) return null;
    if (text.includes('### INTERNAL MONOLOGUE')) return null;
    if (text.startsWith('{') || text.includes('"tool":') || /\{.*\}/.test(text)) return null;
    const cleaned = text
        .replace(/^\[babel:[^\]]+\]\s*/i, '')
        .replace(/^\[babel\]\s+\d{1,2}:\d{2}:\d{2}\s*/i, '')
        .replace(/^Executor\s+turn\s+\d+\s*\/\s*\d+\s*[:—-]?\s*/i, '')
        .replace(/^Stage\s+\d+\s*\/\s*\d+\s*[—-]\s*/i, '')
        .replace(/\[(?:EXECUTOR_HALTED|QA_REJECTED_MAX_LOOPS|FATAL_ERROR|SHELL_COMMAND_FAILED|VERIFIER_FAILED|ROLLBACK_FAILED|ROLLBACK_APPLIED|WORKTREE_DIRTY_UNSAFE)\]/gi, '')
        .replace(/\[debug\]\s*/i, '')
        .replace(/—/g, '-')
        .replace(/\s+/g, ' ')
        .slice(0, 180);
    if (/^Stage\s+1\s*\/\s*4/i.test(text) || /^Orchestrator\b/i.test(cleaned)) return 'Routing request';
    if (/^Stage\s+2\s*\/\s*4/i.test(text) || /^SWE Agent\b/i.test(cleaned)) return 'Planning change';
    if (/^Stage\s+3\s*\/\s*4/i.test(text) || /^QA Reviewer\b/i.test(cleaned)) return 'Reviewing plan';
    if (/^Stage\s+4\s*\/\s*4/i.test(text) || /^CLI Executor\b/i.test(cleaned) || /^Executor\b/i.test(text)) return 'Applying change';
    if (/^Run directory:/i.test(cleaned)) return 'Run evidence created';
    if (/^DRY RUN mode active/i.test(cleaned)) return 'Dry run mode active';
    if (/^Execution profile:/i.test(cleaned)) return `Using ${cleaned.replace(/^Execution profile:\s*/i, '')} profile`;
    if (/^Resolved typed stack/i.test(cleaned)) return 'Loaded task context';
    if (/^v9 stack telemetry:/i.test(cleaned)) return null;
    if (/^Tool project root:/i.test(cleaned)) return null;
    if (/^Project:/i.test(cleaned)) return null;
    if (/^Model:/i.test(cleaned)) return null;
    if (/^Provider:/i.test(cleaned)) return null;
    if (/^Router:/i.test(cleaned)) return null;
    if (/model_context|provider|prompt_manifest|instruction_stack|selected_entry_ids|provider_model_id|assigned_model|model_adapter|prompt-stack|prompt stack|telemetry/i.test(cleaned)) return null;
    if (/^Mode:/i.test(cleaned)) return null;
    if (/^Pipeline mode/i.test(cleaned)) return null;
    if (/^Action steps:/i.test(cleaned)) return 'Prepared plan';
    if (/^Mode is "direct"/i.test(cleaned)) return 'Direct mode complete; no files applied';
    if (/^Pipeline complete/i.test(cleaned)) return 'Run completed';
    if (/^QA:\s*PASS/i.test(cleaned)) return 'Review passed';
    if (/^QA:\s*(REJECT|FAIL)/i.test(cleaned)) return 'Review blocked';
    if (/QA.*PASS|review.*pass/i.test(cleaned)) return 'Review passed';
    if (/QA.*REJECT|QA.*FAIL|review.*reject|review.*blocked/i.test(cleaned)) return 'Review blocked';
    if (/Review cancelled|Pipeline halted|EXECUTOR_HALTED/i.test(cleaned)) return 'Run blocked';
    if (/directory_list|file_read|semantic_search|Reading/i.test(cleaned)) return 'Reading files';
    if (/file_write|patched|applying/i.test(cleaned)) return 'Applying change';
    if (/test_run|verifier|verification|npm test|pytest|gradle test/i.test(cleaned)) return 'Running verifier';
    if (/^Evidence bundle:/i.test(cleaned)) return 'Evidence bundle ready';
    return cleaned;
}

function runtimeEventLabel(event) {
    if (!event?.event_type) return null;
    if (event.event_type === 'session.started') return null;
    if (event.event_type === 'session.completed') return null;
    if (event.event_type === 'verification.decision') {
        const decision = event.payload?.decision ?? event.payload?.status;
        return decision ? `Verification ${String(decision).toLowerCase()}` : 'Verification recorded';
    }
    if (event.event_type === 'policy.decision') return 'Policy decision recorded';
    if (event.event_type === 'tool.requested' || event.event_type === 'tool.completed') {
        const tool = String(event.payload?.tool ?? '');
        if (/directory_list|file_read|semantic_search/i.test(tool)) return 'Reading files';
        if (/test_run|verifier/i.test(tool)) return 'Running verifier';
        return 'Applying change';
    }
    return null;
}

export class TtyHudRenderer extends WaterfallRenderer {}

export class AppendOnlyRenderer {
    constructor(eventBus, context = {}) {
        this.context = context;
        this.startTime = Date.now();
        this.outputBroken = false;
        this.lastMessage = null;
        this.activityKeys = new Set();
        this.transcriptLines = [];
        this.removeStdoutErrorGuard = installStdoutErrorGuard(() => {
            this.outputBroken = true;
        });
        eventBus.on('stage', (index) => this.write(stageAction(index)));
        eventBus.on('log', (line) => {
            const normalized = normalizeActivityLine(line);
            if (normalized) this.write(normalized);
        });
        eventBus.on('runtime_event', (event) => {
            const label = runtimeEventLabel(event);
            if (label) this.write(label);
        });
        eventBus.on('prompt_pause', (label) => this.write(String(label ?? 'Waiting for user input')));
        eventBus.on('prompt_resume', () => this.write('Resuming work'));
    }

    start() {
        this.write(`Babel started: ${this.context.task ?? 'run'}`);
        if (this.context.targetProject || this.context.project) {
            this.write(`Target: ${this.context.targetProject ?? this.context.project}`);
        }
        if (this.context.projectRoot && this.context.projectRoot !== process.cwd()) {
            this.write(`Target root: ${this.context.projectRoot}`);
        }
    }

    stop() {
        this.removeStdoutErrorGuard?.();
    }

    fail(error) {
        const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
        this.write(`Babel failed: ${message}`);
        this.stop();
    }

    write(message) {
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
    }

    getTranscript() {
        return this.transcriptLines.join('\n');
    }

    pauseForPrompt(label = 'Waiting for user input') {
        this.write(String(label));
    }

    resume() {
        this.write('Resuming work');
    }
}

export class NoopRenderer {
    start() {}
    stop() {}
    fail() {}
    getTranscript() { return ''; }
}

export function createLiveRunRenderer(eventBus, context = {}, stream = process.stdout) {
    if (!stream?.isTTY) {
        return new AppendOnlyRenderer(eventBus, context);
    }
    if (process.env.NO_COLOR || process.env.CI) {
        return new AppendOnlyRenderer(eventBus, context);
    }
    return new TtyHudRenderer(eventBus, context);
}

/**
 * Creates a simple activity spinner for the one-shot `babel run` path.
 * Does not require BabelEventBus. Shows elapsed time and cost.
 * @param {string} label — Initial label text shown next to the spinner.
 * @returns {{ start: () => void, stop: (finalLine?: string) => void, update: (label: string) => void }}
 */
export function createRunSpinner(label) {
    let frameIdx = 0;
    let timer = null;
    let currentLabel = label;
    let outputBroken = false;
    let removeStdoutErrorGuard = null;
    const startTime = Date.now();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    const render = () => {
        if (outputBroken) return;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const stats = globalCostTracker.getSessionSummary();
        const costStr = stats.totalCostUSD.toFixed(4);
        const frame = accentBright(frames[frameIdx % frames.length]);
        
        const line = `${frame} ${muted(elapsed + 's')}  ${accentBright('$' + costStr)} ${muted('USD')}  ${primary(currentLabel)}`;
        if (!safeLogUpdate(line)) {
            outputBroken = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }
        frameIdx++;
    };

    return {
        start: () => {
            removeStdoutErrorGuard = installStdoutErrorGuard(() => {
                outputBroken = true;
                if (timer) {
                    clearInterval(timer);
                    timer = null;
                }
            });
            if (process.stdout.isTTY) {
                safeStdoutWrite('\u001B[?25l'); // hide cursor
            }
            render();
            timer = setInterval(render, 80);
        },
        update: (newLabel) => {
            currentLabel = newLabel;
            render();
        },
        stop: (finalLine = '') => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            safeLogUpdateDone();
            if (finalLine) {
                safeStdoutWrite(finalLine + '\n');
            }
            if (process.stdout.isTTY) {
                safeStdoutWrite('\u001B[?25h'); // show cursor
            }
            removeStdoutErrorGuard?.();
            removeStdoutErrorGuard = null;
        }
    };
}
