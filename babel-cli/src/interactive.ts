import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ReadlineWithHistory extends readline.Interface { history: string[]; }
import logUpdate from 'log-update';
import { runBabelPipeline, BabelEventBus } from './pipeline.js';
import {
    renderRunPrelude,
    renderProgressLabel,
    renderResultSummary,
    renderOperatorHeader,
    renderPlanModeWarning,
} from './ui/renderers.js';
import {
    accentBright, muted, primary, dim, bold, ghost,
    getTerminalWidth, padRight, truncate
} from './ui/theme.js';
import { createLiveRunRenderer } from './ui/waterfall.js';
import { resolveModelByKey, getAvailableModels } from './modelPolicy.js';
import { globalCostTracker } from './services/costTracker.js';
import { loadHistory, saveHistory } from './services/history.js';
import { BABEL_ROOT, BABEL_RUNS_DIR, VALID_MODES, type ValidMode } from './cli/constants.js';
import { detectProjectFromCwd } from './cli/helpers.js';
import {
    APPROVAL_PROFILE_DEFINITIONS,
    APPROVAL_PROFILES,
    parseApprovalProfile,
    readApprovalProfileStatus,
    writeApprovalProfile,
} from './config/approvalProfiles.js';
import { readMcpServers } from './config/mcpServers.js';
import { formatMcpDoctorHuman, runMcpDoctor } from './services/mcpDoctor.js';
import {
    handleMcpPromptGet,
    handleMcpPromptList,
    handleMcpResourceList,
    handleMcpResourceRead,
    handleMcpToolSearch,
} from './tools/mcpTransport.js';
import {
    formatPluginDoctorHuman,
    formatPluginListHuman,
    loadPluginRegistry,
    runPluginCommand,
} from './services/plugins.js';
import {
    findCheckpoint,
    formatCheckpointInspect,
    formatCheckpointList,
    listCheckpoints,
    restoreCheckpoint,
} from './services/checkpoints.js';
import {
    formatAgentListHuman,
    formatAgentMergeHuman,
    formatAgentRunHuman,
    inspectAgentRun,
    listAgentRuns,
    mergeAgentRun,
    runAgentTeamFromFile,
    type AgentIsolationMode,
} from './services/agentTeams.js';
import {
    prepareContextInjection,
    summarizeContextInjection,
    writeContextInjectionEvidence,
} from './services/contextInjection.js';
import { createJsonEventStream } from './services/eventStream.js';
import {
    buildRunResultPayload,
    buildAskResultPayload,
    formatRunResultHuman,
    writeHumanSummaryArtifact,
} from './cli/structuredOutput.js';
import { runAskAnswerPath } from './services/askAnswer.js';
import { classifyDoTask } from './commands/workflowCommands.js';
import { resolveAgentTarget, type AgentTargetContext } from './services/targetResolver.js';
import {
    readExecutorSessionContext,
    summarizeExecutorSessionContext,
} from './services/sessionContext.js';
import {
    buildRunStats,
    formatRunStatsHuman,
} from './services/runStats.js';
import {
    buildInspectRunView,
    loadInspectBundle,
} from './inspect/loaders.js';
import { formatDoctorHuman, runDoctor } from './doctor.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionState {
    mode: ValidMode;
    project?: string;
    model?: string;
    resolvedModelId?: string;
    approximateCostPerRunUsd?: number;
    router: 'v9';
    lastRunUserStatus?: 'ready' | 'complete' | 'blocked' | 'failed';
    lastRunTargetRoot?: string | null;
}

interface InteractiveTurn {
    schema_version: 1;
    turn_id: number;
    ts: string;
    role: 'user' | 'assistant';
    input?: string;
    resolved_task?: string;
    answer?: string;
    summary?: string;
    run_dir?: string | null;
    target_root?: string | null;
    workspace_root?: string | null;
    changed_files?: string[];
    verification?: string | null;
    next?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODE_DESCRIPTIONS: Record<string, string> = {
    'verified':   'Governance-first; mandatory QA review before execution.',
    'autonomous': 'Full agency; model executes tools automatically after approval.',
    'direct':     'Fast-path; skips QA and manual plan gates for trusted tasks.',
    'manual':     'Bridge mode; model prepares a plan for manual executor launch.',
    'parallel_swarm': 'Fan-out mode; routes separable work through parallel executors.',
};

const STAGE_LABELS = ['Orchestrator', 'SWE Agent', 'QA Reviewer', 'Executor'];

const INTERACTIVE_COMMAND_GROUPS = [
    {
        title: 'Daily',
        commands: [
            ['/doctor', 'Run workspace health checks'],
            ['/status', 'Show current session state'],
            ['/permissions [profile]', 'Show or set approval profile'],
            ['/mode [name]', 'List modes, or switch mode'],
            ['/model [key]', 'List models, or set active model'],
            ['/project [name]', 'Set project context or clear it'],
            ['/target', 'Show current target root'],
            ['/retarget [path]', 'Override target root for this session'],
        ],
    },
    {
        title: 'Inspection',
        commands: [
            ['/runs', 'List recent run directories'],
            ['/inspect', 'Inspect the latest run bundle'],
            ['/stats', 'Show performance and usage stats'],
            ['/tools', 'List local tool surfaces'],
            ['/policy', 'Show active model policy'],
            ['/memory', 'Show Chronicle memory surfaces'],
        ],
    },
    {
        title: 'Recovery',
        commands: [
            ['/checkpoint', 'List, inspect, or restore run checkpoints'],
            ['/restore <id>', 'Restore a checkpoint by id'],
            ['/session', 'Show resume context for a run'],
        ],
    },
    {
        title: 'Integrations',
        commands: [
            ['/mcp', 'List configured MCP servers'],
            ['/plugins', 'List runtime plugins and diagnostics'],
            ['/plugin <id> <cmd>', 'Run plugin custom command'],
            ['/agents', 'List, run, inspect, or merge agent team specs'],
        ],
    },
    {
        title: 'Session',
        commands: [
            ['/dashboard', 'Show session dashboard and live stats'],
            ['/cost', 'Show session financial summary'],
            ['/history', 'Show persistent command history'],
            ['/chat', 'Show this session transcript'],
            ['/copy', 'Print the latest assistant answer'],
            ['/verbose', 'Toggle verbose log output'],
            ['/clear', 'Clear the terminal'],
            ['/exit', 'End session'],
        ],
    },
] as const;

const INTERACTIVE_COMMAND_COMPLETIONS = [
    ...INTERACTIVE_COMMAND_GROUPS.flatMap((group) => group.commands.map(([command]) => command.split(' ')[0] ?? command)),
    '/h',
    '/help',
    '/m',
    '/p',
    '/q',
    '/quit',
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Helpers handled by imported renderers

function getRecentRuns(limit = 5): string[] {
    try {
        if (!fs.existsSync(BABEL_RUNS_DIR)) return [];
        return fs.readdirSync(BABEL_RUNS_DIR)
            .filter(d => fs.statSync(path.join(BABEL_RUNS_DIR, d)).isDirectory())
            .sort()
            .reverse()
            .slice(0, limit)
            .map(d => path.join(BABEL_RUNS_DIR, d));
    } catch {
        return [];
    }
}

function userStatusForRun(status: string): 'complete' | 'blocked' | 'failed' {
    if (status === 'COMPLETE' || status === 'COMPLETE_NO_MODIFICATION' || status === 'PLAN_READY') {
        return 'complete';
    }
    if (/FAILED|FATAL|ERROR/i.test(status)) {
        return 'failed';
    }
    return 'blocked';
}

// ─── REPL Class ───────────────────────────────────────────────────────────────

export class BabelRepl {
    private rl: readline.Interface;
    private state: SessionState;
    private isRunning: boolean = false;
    private logBuffer: string[] = [];
    private currentStageIdx: number = 0;
    private verboseMode: boolean = false;
    private lastRunDir: string | null = null;
    private readonly interactiveSessionId: string;
    private readonly interactiveSessionDir: string;
    private readonly interactiveTranscriptPath: string;
    private turnCounter = 0;
    private turns: InteractiveTurn[] = [];
    private lastAssistantAnswer: string | null = null;
    private lastAssistantNext: string | null = null;
    private lastResolvedTask: string | null = null;
    private lastTargetRoot: string | null = null;
    private lastWorkspaceRoot: string | null = null;
    private targetOverrideRoot: string | null = null;

    constructor(initialState?: Partial<SessionState>) {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: dim('› '),
            historySize: 100,
            completer: (line: string) => this.completer(line),
        });

        // Inject persistent history
        const savedHistory = loadHistory();
        if (savedHistory.length > 0) {
            (this.rl as ReadlineWithHistory).history = savedHistory;
        }

        this.state = {
            mode: initialState?.mode ?? 'verified',
            ...(initialState?.project !== undefined
                ? { project: initialState.project }
                : detectProjectFromCwd() !== null
                    ? { project: detectProjectFromCwd()! }
                    : {}),
            router: 'v9',
            ...(initialState?.model !== undefined ? { model: initialState.model } : {}),
            lastRunUserStatus: initialState?.lastRunUserStatus ?? 'ready',
            lastRunTargetRoot: initialState?.lastRunTargetRoot ?? null,
        };

        if (this.state.model) {
            this.resolveSessionModel();
        }

        this.interactiveSessionId = `interactive_${new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 17)}`;
        this.interactiveSessionDir = path.join(BABEL_RUNS_DIR, 'interactive-sessions', this.interactiveSessionId);
        this.interactiveTranscriptPath = path.join(this.interactiveSessionDir, 'transcript.jsonl');
        fs.mkdirSync(this.interactiveSessionDir, { recursive: true });

        // NOTE: We do NOT subscribe to process events here. Each run gets its
        // own BabelEventBus instance (created in executeTask) which is cleaned
        // up automatically.

        this.setupEventListeners();
    }

    // Suggestion hint is shown via readline's completer — no custom ANSI needed

    private setupEventListeners(): void {
        process.stdout.on('resize', () => {
            if (!this.isRunning) this.printIdleHeader();
        });
    }

    public async start(): Promise<void> {
        process.stdout.write('\u001bc'); // clear screen
        await this.loop();
    }

    // ── Idle header — written once per command, not in a loop ─────────────────
    private printIdleHeader(): void {
        const header = renderOperatorHeader(this.state);
        const hint = muted('  › type a task, or /help for commands\n');
        process.stdout.write(header + hint);
    }

    private async loop(): Promise<void> {
        this.printIdleHeader();
        this.rl.prompt();

        this.rl.on('line', async (line) => {
            this.currentStageIdx = 0;
            const input = line.trim();
            if (!input) {
                this.rl.prompt();
                return;
            }

            // Persist history on every non-empty input
            saveHistory((this.rl as ReadlineWithHistory).history);

            if (input.startsWith('/')) {
                await this.handleCommand(input);
            } else {
                await this.executeTask(input);
            }

            if (!this.isRunning) {
                this.printIdleHeader();
                this.rl.prompt();
            }
        });

        this.rl.on('SIGINT', () => this.exit());
    }

    // ── Autocomplete ──────────────────────────────────────────────────────────

    private completer(line: string): [string[], string] {
        // Subcommand completion for /mode
        if (line.startsWith('/mode ')) {
            const sub = line.slice(6);
            const modes = [...VALID_MODES];
            const hits = modes.filter(m => m.startsWith(sub));
            // Return full replacement strings so readline fills in correctly
            return [hits.map(h => `/mode ${h}`), line];
        }

        if (line.startsWith('/permissions ')) {
            const sub = line.slice(13);
            const hits = APPROVAL_PROFILES.filter(profile => profile.startsWith(sub));
            return [hits.map(h => `/permissions ${h}`), line];
        }

        // Subcommand completion for /model
        if (line.startsWith('/model ')) {
            const sub = line.slice(7);
            const models = ['autonomous', 'clear', 'deepseek', 'nemotron', 'qwen3', 'qwen3-32b', 'scout', 'step-flash'];
            const hits = models.filter(m => m.startsWith(sub));
            return [hits.map(h => `/model ${h}`), line];
        }

        // Base command completion
        if (line.startsWith('/')) {
            const hits = INTERACTIVE_COMMAND_COMPLETIONS.filter(c => c.startsWith(line));
            return [hits, line];
        }

        return [[], line];
    }

    // ── Command router ────────────────────────────────────────────────────────

    private async handleCommand(input: string): Promise<void> {
        const parts = input.slice(1).split(' ');
        const cmd   = parts[0]?.toLowerCase() ?? '';
        const args  = parts.slice(1);

        switch (cmd) {
            // ── Session control ──────────────────────────────────────────────
            case 'exit': case 'quit': case 'q':
                this.exit();
                break;

            case 'clear':
                process.stdout.write('\u001bc');
                break;

            case 'history':   this.showHistory();   break;
            case 'chat':      this.showChatTranscript(); break;
            case 'copy':      this.showLatestAnswer(); break;
            case 'dashboard': this.showDashboard(); break;
            case 'verbose': {
                this.verboseMode = !this.verboseMode;
                console.log(primary(`\n  Verbose log mode: ${this.verboseMode ? accentBright('ON') : muted('off')}`));
                break;
            }

            // ── Help ─────────────────────────────────────────────────────────
            case 'help': case 'h':
                this.showHelp();
                break;

            // ── Status ───────────────────────────────────────────────────────
            case 'status':
                this.showStatus();
                break;

            case 'doctor':
                await this.showDoctor();
                break;

            case 'permissions':
                this.handlePermissions(args);
                break;

            case 'mcp':
                await this.showMcpServers(args);
                break;

            case 'tools':
                this.showTools();
                break;

            case 'plugins':
                this.showPlugins(args);
                break;

            case 'plugin':
                await this.runPluginCommand(args);
                break;

            case 'checkpoint':
                this.handleCheckpoint(args);
                break;

            case 'restore':
                this.handleRestore(args);
                break;

            case 'session':
                this.handleSession(args);
                break;

            case 'agents':
                this.handleAgents(args);
                break;

            case 'memory':
                this.showMemory();
                break;

            // ── Mode ─────────────────────────────────────────────────────────
            case 'mode':
                if (args[0]) {
                    const mode = args[0].toLowerCase() as ValidMode;
                    if (VALID_MODES.includes(mode)) {
                        this.state.mode = mode;
                        console.log(primary(`\n  Mode set to ${accentBright(mode)}`));
                    } else {
                        console.log(accentBright(`\n  Invalid mode: "${args[0]}". Available options:`));
                        Object.entries(MODE_DESCRIPTIONS).forEach(([k, v]) =>
                            console.log(`    - ${accentBright(padRight(k, 12))} ${muted(v)}`));
                    }
                } else {
                    console.log(primary('\n  Available Modes:'));
                    Object.entries(MODE_DESCRIPTIONS).forEach(([k, v]) =>
                        console.log(`    - ${accentBright(padRight(k, 12))} ${muted(v)}`));
                    console.log(muted(`\n  Current: ${accentBright(this.state.mode)}`));
                    console.log(muted(`  Use '/mode <name>' to switch.`));
                }
                break;

            // ── Project ──────────────────────────────────────────────────────
            case 'project': case 'p':
                if (args[0]) {
                    this.state.project = args[0];
                    console.log(primary(`\n  Project set to ${accentBright(args[0])}`));
                } else {
                    delete (this.state as any).project;
                    console.log(primary('\n  Project cleared — auto-detect enabled'));
                }
                break;

            case 'target':
                this.showTarget();
                break;

            case 'retarget': {
                const requested = args.join(' ').trim();
                this.targetOverrideRoot = requested ? path.resolve(requested) : null;
                const target = this.resolveCurrentTarget();
                console.log(primary(`\n  Target set to ${accentBright(target.targetRoot)}`));
                if (!requested) {
                    console.log(muted('  Override cleared; using automatic cwd/project target resolution.'));
                }
                break;
            }

            // ── Model ────────────────────────────────────────────────────────
            case 'model': case 'm':
                if (args[0] && args[0].toLowerCase() !== 'clear') {
                    const requested = args[0].toLowerCase();
                    try {
                        const resolved = resolveModelByKey({ key: requested });
                        this.state.model = resolved.resolvedBackendKey;
                        this.state.resolvedModelId = resolved.providerModelId;
                        this.state = {
                            ...this.state,
                            ...(resolved.approximateCostPerRunUsd !== undefined
                                ? { approximateCostPerRunUsd: resolved.approximateCostPerRunUsd }
                                : {}),
                        };
                        console.log(primary(`\n  Model set to ${accentBright(resolved.resolvedBackendKey)} ${muted(`(approx. $${resolved.approximateCostPerRunUsd?.toFixed(4)}/run)`)}`));
                    } catch {
                        const available = getAvailableModels()
                            .map(m => `    - ${accentBright(m.key)}: ${muted(`$${m.entry.estimated_cost_per_1m_output}/M`)}`)
                            .join('\n');
                        console.log(accentBright(`\n  Invalid model: "${requested}". Available backends:`));
                        console.log(available);
                    }
                } else if (args[0]?.toLowerCase() === 'clear') {
                    delete (this.state as any).model;
                    delete (this.state as any).resolvedModelId;
                    delete (this.state as any).approximateCostPerRunUsd;
                    console.log(primary('\n  Model cleared — route-selected enabled'));
                } else {
                    console.log(primary('\n  Available Models:'));
                    const available = getAvailableModels()
                        .map(m => `    - ${accentBright(padRight(m.key, 12))} ${muted(`$${padRight((m.entry.estimated_cost_per_1m_output ?? 0).toString(), 6)}/M`)}${m.entry.selection_reason ? `  ${muted(m.entry.selection_reason)}` : ''}`)
                        .join('\n');
                    console.log(available);
                    console.log(muted(`\n  Use '/model <key>' to select, or '/model clear' to reset.`));
                }
                break;

            // ── Runs ─────────────────────────────────────────────────────────
            case 'runs': {
                const recent = getRecentRuns(5);
                if (recent.length === 0) {
                    console.log(muted('\n  No runs found.'));
                } else {
                    console.log(primary('\n  Recent Runs:'));
                    recent.forEach((r, i) => console.log(`    ${muted(String(i + 1) + '.')} ${truncate(r, getTerminalWidth() - 8)}`));
                    console.log(muted('\n  Use /inspect to open the latest run.'));
                }
                break;
            }

            // ── Inspect ──────────────────────────────────────────────────────
            case 'inspect': {
                const target = this.lastRunDir ?? getRecentRuns(1)[0];
                if (!target) {
                    console.log(muted('\n  No runs to inspect.'));
                } else {
                    console.log(primary(`\n  Run bundle: ${target}`));
                    const files = fs.existsSync(target)
                        ? fs.readdirSync(target).filter(f => f.endsWith('.json') || f.endsWith('.md'))
                        : [];
                    files.forEach(f => console.log(`    ${muted('·')} ${f}`));
                    console.log(muted(`\n  Open in editor: $EDITOR "${target}"`));
                }
                break;
            }

            // ── Policy ───────────────────────────────────────────────────────
            case 'policy': {
                const models = getAvailableModels();
                console.log(primary('\n  Active Model Policy:'));
                models.forEach(m => {
                    console.log(`    ${accentBright(padRight(m.key, 12))} ${muted(`$${padRight((m.entry.estimated_cost_per_1m_output ?? 0).toString(), 6)}/M`)}  ${m.entry.selection_reason ? muted(m.entry.selection_reason) : ''}`);
                });
                break;
            }

            // ── Verbose ──────────────────────────────────────────────────────
            case 'verbose':
                this.verboseMode = !this.verboseMode;
                console.log(primary(`\n  Verbose log mode: ${this.verboseMode ? accentBright('ON') : muted('off')}`));
                break;

            // ── Financials ───────────────────────────────────────────────────
            case 'cost': {
                const summary = globalCostTracker.getSessionSummary();
                console.log(primary('\n  Session Cost Summary:'));
                console.log(`    ${muted(padRight('Total USD', 14))} ${accentBright('$' + summary.totalCostUSD.toFixed(6))}`);
                console.log(primary('\n  Breakdown by Model:'));
                Object.entries(summary.modelBreakdown).forEach(([model, usage]) => {
                    const shortName = model.split('/').pop() ?? model;
                    console.log(`    ${accentBright(padRight(shortName, 24))} ${muted(`In: ${usage.inputTokens.toString().padStart(8)}`)} ${muted(`Out: ${usage.outputTokens.toString().padStart(8)}`)} ${accentBright(`$${usage.costUSD.toFixed(6)}`)}`);
                });
                console.log(muted('\n  Use /stats for lifetime project totals.'));
                break;
            }

            case 'stats': {
                this.showStats(args);
                break;
            }

            default:
                console.log(accentBright(`\n  Unknown command: /${cmd}. Type /help for available commands.`));
        }
    }

    // ── Help ─────────────────────────────────────────────────────────────────

    private showHelp(): void {
        const cmd = (s: string) => primary(s.padEnd(22));
        console.log(primary('\n  Interactive Command Guide:\n'));
        for (const group of INTERACTIVE_COMMAND_GROUPS) {
            console.log(primary(`  ${group.title}:`));
            for (const [command, description] of group.commands) {
                console.log(`    ${cmd(command)}  ${muted(description)}`);
            }
        }
        console.log(muted('\n  Daily path: /doctor -> /status -> type a task. After a run: /inspect -> /checkpoint list -> /session.'));
        console.log(muted('  Equivalent CLI commands: babel doctor, babel inspect run latest, babel checkpoint list, babel session resume latest.\n'));
    }

    private handlePermissions(args: string[]): void {
        const requested = args[0]?.toLowerCase();
        if (!requested) {
            const status = readApprovalProfileStatus();
            console.log(primary('\n  Approval Profile:'));
            console.log(`    ${muted(padRight('Profile', 14))} ${accentBright(status.profile)}`);
            console.log(`    ${muted(padRight('Runtime', 14))} ${status.runtimeMode}`);
            console.log(`    ${muted(padRight('Dry run', 14))} ${status.dryRun.effective ? accentBright('on') : muted('off')}`);
            console.log(muted('\n  Available profiles:'));
            APPROVAL_PROFILES.forEach(profile => {
                console.log(`    - ${accentBright(padRight(profile, 10))} ${muted(APPROVAL_PROFILE_DEFINITIONS[profile].description)}`);
            });
            return;
        }

        const profile = parseApprovalProfile(requested);
        if (!profile) {
            console.log(accentBright(`\n  Invalid profile: "${requested}". Use ${APPROVAL_PROFILES.join(', ')}.`));
            return;
        }

        const status = writeApprovalProfile(profile);
        console.log(primary(`\n  Approval profile set to ${accentBright(status.profile)}`));
        console.log(muted(`  Runtime: ${status.runtimeMode}; dry-run: ${status.dryRun.effective ? 'on' : 'off'}`));
    }

    private async showDoctor(): Promise<void> {
        try {
            const result = await runDoctor({
                babelRoot: BABEL_ROOT,
                scope: 'workspace',
                strict: false,
                verbose: false,
            });
            console.log('\n' + formatDoctorHuman(result, false));
        } catch (error: any) {
            console.log(accentBright(`\n  Doctor failed: ${error.message}`));
        }
    }

    private parseMcpPromptArgs(args: string[]): Record<string, unknown> {
        const parsed: Record<string, unknown> = {};
        for (const arg of args) {
            const eq = arg.indexOf('=');
            if (eq <= 0) {
                throw new Error(`Prompt argument must be key=value: ${arg}`);
            }
            parsed[arg.slice(0, eq)] = arg.slice(eq + 1);
        }
        return parsed;
    }

    private async printMcpResult(resultPromise: Promise<{ exit_code: number; stdout: string; stderr: string }>): Promise<void> {
        const result = await resultPromise;
        if (result.stdout) {
            try {
                console.log('\n' + JSON.stringify(JSON.parse(result.stdout), null, 2));
            } catch {
                console.log('\n' + result.stdout);
            }
        }
        if (result.stderr) {
            console.log(accentBright('\n  ' + result.stderr));
        }
    }

    private async showMcpServers(args: string[] = []): Promise<void> {
        const subcommand = args[0]?.toLowerCase();
        if (subcommand === 'doctor') {
            console.log('\n' + formatMcpDoctorHuman(runMcpDoctor()));
            return;
        }

        if (subcommand === 'tools') {
            const server = args[1];
            if (!server) {
                console.log(accentBright('\n  Usage: /mcp tools <server> [query]'));
                return;
            }
            await this.printMcpResult(handleMcpToolSearch({
                tool: 'mcp_tool_search',
                server,
                ...(args[2] ? { query: args.slice(2).join(' ') } : {}),
            }));
            return;
        }

        if (subcommand === 'resources') {
            const server = args[1];
            if (!server) {
                console.log(accentBright('\n  Usage: /mcp resources <server>'));
                return;
            }
            await this.printMcpResult(handleMcpResourceList({ tool: 'mcp_resource_list', server }));
            return;
        }

        if (subcommand === 'resource') {
            const server = args[1];
            const uri = args[2];
            if (!server || !uri) {
                console.log(accentBright('\n  Usage: /mcp resource <server> <uri>'));
                return;
            }
            await this.printMcpResult(handleMcpResourceRead({ tool: 'mcp_resource_read', server, uri }));
            return;
        }

        if (subcommand === 'prompts') {
            const server = args[1];
            if (!server) {
                console.log(accentBright('\n  Usage: /mcp prompts <server>'));
                return;
            }
            await this.printMcpResult(handleMcpPromptList({ tool: 'mcp_prompt_list', server }));
            return;
        }

        if (subcommand === 'prompt') {
            const server = args[1];
            const name = args[2];
            if (!server || !name) {
                console.log(accentBright('\n  Usage: /mcp prompt <server> <name> [key=value...]'));
                return;
            }
            try {
                await this.printMcpResult(handleMcpPromptGet({
                    tool: 'mcp_prompt_get',
                    server,
                    name,
                    arguments: this.parseMcpPromptArgs(args.slice(3)),
                }));
            } catch (error) {
                console.log(accentBright(`\n  ${error instanceof Error ? error.message : String(error)}`));
            }
            return;
        }

        const servers = readMcpServers();
        console.log(primary('\n  MCP Servers:'));
        Object.entries(servers).forEach(([name, server]) => {
            console.log(`    ${accentBright(padRight(name, 14))} ${muted(`${server.command} ${server.args.join(' ')}`.trim())}`);
        });
        console.log(muted('\n  Slash: /mcp doctor  /mcp tools <server> [query]  /mcp resources <server>'));
        console.log(muted('         /mcp prompts <server>  /mcp prompt <server> <name> [key=value...]'));
        console.log(muted('  CLI: babel mcp add|remove|list|status|doctor|tools|resources|prompts'));
    }

    private showTools(): void {
        const tools = [
            'directory_list',
            'file_read',
            'file_write',
            'shell_exec',
            'test_run',
            'mcp_request',
            'mcp_resource_list',
            'mcp_resource_read',
            'mcp_prompt_list',
            'mcp_prompt_get',
            'mcp_tool_search',
            'web_search',
            'web_fetch',
            'audit_ui',
            'memory_store',
            'memory_query',
            'semantic_search',
            'plugin_tool',
        ];
        console.log(primary('\n  Local Tools:'));
        tools.forEach(tool => console.log(`    ${muted('·')} ${accentBright(tool)}`));
        console.log(muted('\n  Evidence: /doctor  /inspect  /runs'));
    }

    private showPlugins(args: string[] = []): void {
        const subcommand = args[0]?.toLowerCase();
        if (subcommand === 'doctor') {
            console.log('\n' + formatPluginDoctorHuman(loadPluginRegistry()));
            return;
        }
        console.log('\n' + formatPluginListHuman(loadPluginRegistry()));
        console.log(muted('\n  Slash: /plugin <plugin_id> <command> [args...]'));
        console.log(muted('  CLI: babel plugins list|inspect|enable|disable|doctor|command'));
    }

    private async runPluginCommand(args: string[]): Promise<void> {
        const pluginId = args[0];
        const commandName = args[1];
        if (!pluginId || !commandName) {
            console.log(accentBright('\n  Usage: /plugin <plugin_id> <command> [args...]'));
            return;
        }

        const result = await runPluginCommand(pluginId, commandName, args.slice(2));
        if (result.exit_code === 0) {
            console.log('\n' + result.stdout.trimEnd());
        } else {
            console.log(accentBright('\n  ' + result.stderr));
        }
    }

    private resolveRunDir(arg?: string): string {
        if (!arg || arg.toLowerCase() === 'latest') {
            const latest = this.lastRunDir ?? getRecentRuns(1)[0];
            if (!latest) {
                throw new Error('No recent run is available.');
            }
            return latest;
        }
        return path.resolve(arg);
    }

    private handleCheckpoint(args: string[]): void {
        const subcommand = args[0]?.toLowerCase() ?? 'list';
        try {
            if (subcommand === 'list') {
                const runDir = this.resolveRunDir(args[1]);
                console.log('\n' + formatCheckpointList(listCheckpoints(runDir)));
                return;
            }
            if (subcommand === 'inspect') {
                const checkpointId = args[1];
                if (!checkpointId) {
                    console.log(accentBright('\n  Usage: /checkpoint inspect <id> [run]'));
                    return;
                }
                const runDir = args[2] ? this.resolveRunDir(args[2]) : undefined;
                const resolved = runDir ? findCheckpoint(checkpointId, { runDir }) : findCheckpoint(checkpointId);
                console.log('\n' + formatCheckpointInspect(resolved.record));
                return;
            }
            if (subcommand === 'restore') {
                this.handleRestore(args.slice(1));
                return;
            }
            console.log(accentBright('\n  Usage: /checkpoint [list|inspect|restore] ...'));
        } catch (error) {
            console.log(accentBright(`\n  ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    private handleRestore(args: string[]): void {
        const checkpointId = args[0];
        if (!checkpointId) {
            console.log(accentBright('\n  Usage: /restore <checkpoint_id> [--force]'));
            return;
        }
        try {
            const force = args.includes('--force');
            const runArg = args.find((arg) => arg !== checkpointId && arg !== '--force');
            const runDir = runArg ? this.resolveRunDir(runArg) : undefined;
            const resolved = runDir ? findCheckpoint(checkpointId, { runDir }) : findCheckpoint(checkpointId);
            const result = restoreCheckpoint(resolved.record, { force });
            console.log('\n' + JSON.stringify(result, null, 2));
        } catch (error) {
            console.log(accentBright(`\n  ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    private handleSession(args: string[]): void {
        const runArg = args[0]?.toLowerCase() === 'resume' ? args[1] : args[0];
        try {
            const runDir = this.resolveRunDir(runArg);
            const bundle = loadInspectBundle(runDir);
            const view = buildInspectRunView(bundle);
            const checkpoints = listCheckpoints(runDir);
            const modelContext = summarizeExecutorSessionContext(readExecutorSessionContext(runDir));
            console.log(primary('\n  Session Resume:'));
            console.log(`    ${muted(padRight('Run', 14))} ${runDir}`);
            console.log(`    ${muted(padRight('Status', 14))} ${view.finalStatus}`);
            console.log(`    ${muted(padRight('Checkpoints', 14))} ${checkpoints.checkpoints.length}`);
            console.log(`    ${muted(padRight('Context', 14))} ${modelContext.available ? modelContext.status : 'Unavailable'}`);
            console.log(muted(`\n  Next: /inspect  /checkpoint list "${runDir}"  babel resume --run "${runDir}"`));
        } catch (error) {
            console.log(accentBright(`\n  ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    private parseAgentIsolation(args: string[]): AgentIsolationMode | undefined {
        const flagIndex = args.indexOf('--isolation');
        const value = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
        if (!value) {
            return undefined;
        }
        if (value !== 'copy' && value !== 'git_worktree' && value !== 'none') {
            throw new Error(`Invalid isolation mode: ${value}`);
        }
        return value;
    }

    private handleAgents(args: string[]): void {
        const subcommand = args[0]?.toLowerCase() ?? 'list';
        try {
            if (subcommand === 'list') {
                console.log('\n' + formatAgentListHuman(listAgentRuns()));
                return;
            }
            if (subcommand === 'run') {
                const spec = args[1];
                if (!spec) {
                    console.log(accentBright('\n  Usage: /agents run <spec.json> [--isolation copy|git_worktree|none]'));
                    return;
                }
                const isolation = this.parseAgentIsolation(args);
                const run = runAgentTeamFromFile(spec, {
                    ...(isolation ? { isolation } : {}),
                });
                console.log('\n' + formatAgentRunHuman(run));
                return;
            }
            if (subcommand === 'inspect') {
                const id = args[1];
                if (!id) {
                    console.log(accentBright('\n  Usage: /agents inspect <id>'));
                    return;
                }
                console.log('\n' + formatAgentRunHuman(inspectAgentRun(id)));
                return;
            }
            if (subcommand === 'merge') {
                const id = args[1];
                if (!id) {
                    console.log(accentBright('\n  Usage: /agents merge <id>'));
                    return;
                }
                console.log('\n' + formatAgentMergeHuman(mergeAgentRun(id)));
                return;
            }
            console.log(accentBright('\n  Usage: /agents [list|run|inspect|merge] ...'));
        } catch (error) {
            console.log(accentBright(`\n  ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    private showMemory(): void {
        console.log(primary('\n  Chronicle Memory:'));
        console.log(`    ${muted(padRight('Store', 14))} memory_store`);
        console.log(`    ${muted(padRight('Query', 14))} memory_query`);
        console.log(`    ${muted(padRight('Search', 14))} semantic_search`);
        console.log(muted('\n  Memory tools are available to pipeline executors and recorded in run evidence.'));
    }

    // ── Status ───────────────────────────────────────────────────────────────

    private showStatus(): void {
        const permissions = readApprovalProfileStatus();
        console.log(primary('\n  Session State:'));
        console.log(`    ${muted(padRight('Mode', 10))} ${accentBright(this.state.mode)}`);
        console.log(`    ${muted(padRight('Router', 10))} ${this.state.router}`);
        console.log(`    ${muted(padRight('Project', 10))} ${this.state.project ?? muted('(auto-detect)')}`);
        console.log(`    ${muted(padRight('Model', 10))} ${this.state.model ? accentBright(this.state.model) : muted('(route-selected)')}`);
        console.log(`    ${muted(padRight('Profile', 10))} ${accentBright(permissions.profile)}`);
        if (this.state.resolvedModelId) {
            console.log(`    ${muted(padRight('Provider', 10))} ${muted(this.state.resolvedModelId)}`);
        }
        if (this.state.approximateCostPerRunUsd !== undefined) {
            console.log(`    ${muted(padRight('Cost', 10))} ${muted(`$${this.state.approximateCostPerRunUsd.toFixed(4)} / run`)}`);
        }
        console.log(`    ${muted(padRight('Verbose', 10))} ${this.verboseMode ? accentBright('on') : muted('off')}\n`);
    }

    private showStats(args: string[] = []): void {
        const runArg = args[0]?.toLowerCase() === 'run' ? args[1] : args[0];
        const summary = globalCostTracker.getSessionSummary();
        console.log(primary('\n  Session Stats:'));
        console.log(`    ${muted(padRight('Stages', 14))} ${this.currentStageIdx}/4`);
        console.log(`    ${muted(padRight('Session Cost', 14))} ${accentBright('$' + summary.totalCostUSD.toFixed(6))}`);
        if (this.lastRunDir) {
            console.log(`    ${muted(padRight('Last Run', 14))} ${muted(path.basename(this.lastRunDir))}`);
        }
        try {
            const runDir = this.resolveRunDir(runArg);
            const stats = buildRunStats(runDir);
            console.log('');
            console.log(formatRunStatsHuman(stats));
        } catch {
            console.log(muted('\n  No run bundle stats available yet. Run a task or use /stats run <run_dir>.'));
        }
    }

    private appendTurn(turn: Omit<InteractiveTurn, 'schema_version' | 'turn_id' | 'ts'>): InteractiveTurn {
        const record: InteractiveTurn = {
            schema_version: 1,
            turn_id: typeof this.turnCounter === 'number' ? ++this.turnCounter : 1,
            ts: new Date().toISOString(),
            ...turn,
        };
        if (Array.isArray(this.turns)) {
            this.turns.push(record);
        }
        if (this.interactiveTranscriptPath) {
            fs.mkdirSync(path.dirname(this.interactiveTranscriptPath), { recursive: true });
            fs.appendFileSync(this.interactiveTranscriptPath, `${JSON.stringify(record)}\n`, 'utf-8');
        }
        return record;
    }

    private isFollowUpInput(input: string): boolean {
        if (!this.lastAssistantAnswer) {
            return false;
        }
        return /^(why|how|what about|explain|more|continue|go ahead|do that|apply that|make that change|yes|ok|okay)\b/i.test(input.trim());
    }

    private resolveInteractiveTask(input: string): string {
        if (!this.isFollowUpInput(input)) {
            return input;
        }
        const parts = [
            `Follow-up request: ${input}`,
            '',
            'Previous assistant answer:',
            this.lastAssistantAnswer ?? '',
        ];
        if (this.lastAssistantNext) {
            parts.push('', `Previous recommended next step: ${this.lastAssistantNext}`);
        }
        if (this.lastResolvedTask) {
            parts.push('', `Previous resolved task: ${this.lastResolvedTask}`);
        }
        return parts.join('\n');
    }

    private classifyInteractiveLane(input: string): Exclude<ReturnType<typeof classifyDoTask>, 'do'> {
        if (this.lastAssistantAnswer && /\b(do that|apply that|make that change|go ahead|continue)\b/i.test(input)) {
            return 'fix';
        }
        return classifyDoTask(input);
    }

    private extractAnswerFromPayload(payload: Record<string, unknown>, fallback: string): string {
        const answer = payload['answer'];
        if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
            const record = answer as Record<string, unknown>;
            if (typeof record['answer'] === 'string' && record['answer'].trim().length > 0) {
                return record['answer'].trim();
            }
            if (typeof record['summary'] === 'string' && record['summary'].trim().length > 0) {
                return record['summary'].replace(/\bOBJECTIVE:\s*/gi, '').trim();
            }
        }
        const plan = payload['plan'];
        if (plan && typeof plan === 'object' && !Array.isArray(plan)) {
            const summary = (plan as Record<string, unknown>)['task_summary'];
            if (typeof summary === 'string' && summary.trim().length > 0) {
                return summary.replace(/\bOBJECTIVE:\s*/gi, '').trim();
            }
        }
        return fallback;
    }

    private updateConversationMemory(payload: Record<string, unknown>, resolvedTask: string): void {
        this.lastResolvedTask = resolvedTask;
        this.lastAssistantAnswer = this.extractAnswerFromPayload(payload, 'Babel completed the latest turn.');
        const next = payload['next'];
        this.lastAssistantNext = Array.isArray(next) && typeof next[0] === 'string' ? next[0] : null;
    }

    private showChatTranscript(): void {
        if (this.turns.length === 0) {
            console.log(muted('\n  No chat turns recorded yet.'));
            return;
        }
        console.log(primary('\n  Chat Transcript:'));
        for (const turn of this.turns.slice(-12)) {
            const label = turn.role === 'user' ? 'You' : 'Babel';
            const text = turn.role === 'user' ? turn.input : turn.answer ?? turn.summary;
            console.log(`    ${accentBright(padRight(label, 7))} ${muted(String(text ?? '').replace(/\s+/g, ' ').slice(0, 220))}`);
        }
        console.log(muted(`\n  Transcript: ${this.interactiveTranscriptPath}`));
    }

    private showLatestAnswer(): void {
        if (!this.lastAssistantAnswer) {
            console.log(muted('\n  No assistant answer is available yet.'));
            return;
        }
        console.log(`\n${this.lastAssistantAnswer}\n`);
    }

    private resolveCurrentTarget(): AgentTargetContext {
        return resolveAgentTarget({
            ...(this.state.project !== undefined ? { project: this.state.project } : {}),
            ...(this.targetOverrideRoot ? { projectRoot: this.targetOverrideRoot } : {}),
        });
    }

    private showTarget(): void {
        const target = this.resolveCurrentTarget();
        console.log(primary('\n  Target:'));
        console.log(`    ${muted(padRight('Root', 14))} ${accentBright(target.targetRoot)}`);
        console.log(`    ${muted(padRight('Source', 14))} ${target.source}`);
        if (target.workspaceRoot) {
            console.log(`    ${muted(padRight('Workspace', 14))} ${muted(target.workspaceRoot)}`);
        }
        console.log(muted('\n  Use /retarget <path> to override, or /retarget to clear the override.'));
    }

    // ── Task Execution ────────────────────────────────────────────────────────

    private async executeTask(input: string): Promise<void> {
        const resolvedTask = this.resolveInteractiveTask(input);
        const currentTarget = this.resolveCurrentTarget();
        const target = this.isFollowUpInput(input) && !this.targetOverrideRoot && this.lastTargetRoot
            ? {
                ...currentTarget,
                targetRoot: this.lastTargetRoot,
                workspaceRoot: this.lastWorkspaceRoot,
                source: 'current_repo' as const,
            }
            : currentTarget;
        this.appendTurn({
            role: 'user',
            input,
            resolved_task: resolvedTask,
            target_root: target.targetRoot,
            workspace_root: target.workspaceRoot,
        });
        const lane = this.classifyInteractiveLane(input);
        if (lane === 'ask') {
            await this.executeAskTask(input, resolvedTask, target);
            return;
        }
        await this.executeGovernedTask(input, resolvedTask, target);
    }

    private async executeAskTask(input: string, task: string, target: AgentTargetContext): Promise<void> {
        this.isRunning = true;
        this.rl.pause();
        const projectRoot = target.targetRoot;
        this.lastTargetRoot = target.targetRoot;
        this.lastWorkspaceRoot = target.workspaceRoot;
        this.state.lastRunTargetRoot = target.targetRoot;

        try {
            process.stdout.write(primary(`\nTarget: ${projectRoot}\nThinking...\n`));
            const result = await runAskAnswerPath({
                task,
                ...(this.state.project !== undefined ? { project: this.state.project } : {}),
                projectRoot,
                ...(target.workspaceRoot !== null ? { workspaceRoot: target.workspaceRoot } : {}),
                ...(this.state.model !== undefined ? { model: this.state.model } : {}),
            });
            this.lastRunDir = result.runDir;
            this.state.lastRunUserStatus = 'complete';
            const payload = buildAskResultPayload({
                answer: result.answer,
                task,
                ...(this.state.project !== undefined ? { project: this.state.project } : {}),
                projectRoot,
                runDir: result.runDir,
                usageSummary: result.usageSummary,
            }) as unknown as Record<string, unknown>;
            const human = formatRunResultHuman(payload);
            const transcript = [`You: ${input}`, `Babel: ${result.answer.answer || result.answer.summary}`, human].join('\n');
            const review = writeHumanSummaryArtifact(result.runDir, human, transcript);
            this.updateConversationMemory(payload, task);
            this.appendTurn({
                role: 'assistant',
                answer: this.lastAssistantAnswer ?? result.answer.answer,
                summary: result.answer.summary,
                run_dir: result.runDir,
                target_root: target.targetRoot,
                workspace_root: target.workspaceRoot,
                changed_files: [],
                verification: 'not required - read-only request',
                next: this.lastAssistantNext,
            });
            console.log(`\n${human}\n`);
            if (review?.status === 'needs_attention') {
                console.log(muted('  Output review: target mismatch detected\n'));
            }
        } catch (error: any) {
            this.state.lastRunUserStatus = 'failed';
            if (error?.runDir) {
                this.lastRunDir = error.runDir;
            }
            console.error(accentBright(`\n  Ask failed: ${error.message ?? String(error)}\n`));
        } finally {
            this.isRunning = false;
            this.rl.resume();
        }
    }

    private async executeGovernedTask(input: string, task: string, target: AgentTargetContext): Promise<void> {
        this.isRunning = true;
        this.rl.pause();
        process.stdout.write('\u001b[?25l'); // hide cursor

        const bus = new BabelEventBus();
        const eventStream = process.env['BABEL_EVENTS_JSONL']
            ? createJsonEventStream(process.env['BABEL_EVENTS_JSONL'], { bus, runLabel: task.slice(0, 80) })
            : null;
        bus.on('stage', (idx: number) => { this.currentStageIdx = idx; });
        const projectRoot = target.targetRoot;
        this.lastTargetRoot = target.targetRoot;
        this.lastWorkspaceRoot = target.workspaceRoot;
        this.state.lastRunTargetRoot = target.targetRoot;
        const waterfall = createLiveRunRenderer(bus, {
            task,
            mode: this.state.mode,
            project: this.state.project,
            projectRoot,
        });

        try {
            waterfall.start();
            const contextInjection = prepareContextInjection(task, { projectRoot });
            if (contextInjection.attachments.length > 0) {
                this.logBuffer.push(`context: ${summarizeContextInjection(contextInjection)}`);
            }
            const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
            process.env['BABEL_PROJECT_ROOT'] = projectRoot;
            let result;
            try {
                result = await runBabelPipeline(contextInjection.task, {
                    ...(this.state.project !== undefined ? { project: this.state.project } : {}),
                    mode:                this.state.mode,
                    orchestratorVersion: this.state.router,
                    ...(this.state.model !== undefined ? { modelOverride: this.state.model } : {}),
                    eventBus:            bus,
                });
            } finally {
                if (previousProjectRoot === undefined) {
                    delete process.env['BABEL_PROJECT_ROOT'];
                } else {
                    process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
                }
            }

            waterfall.stop();
            this.lastRunDir = result.runDir;
            this.state.lastRunUserStatus = userStatusForRun(result.status);
            if (contextInjection.attachments.length > 0) {
                writeContextInjectionEvidence(result.runDir, contextInjection);
            }
            eventStream?.write('babel.run.result', { run_dir: result.runDir, status: result.status });

            // Update project-level financials
            globalCostTracker.saveToProjectStats(path.basename(result.runDir));

            process.stdout.write('\u001b[?25h');
            this.printRunSummary(result, {
                input,
                task,
                projectRoot,
                transcript: typeof waterfall.getTranscript === 'function' ? waterfall.getTranscript() : '',
            });

        } catch (error: any) {
            this.state.lastRunUserStatus = 'failed';
            waterfall.fail();
            eventStream?.write('babel.run.error', { error: error.message });
            process.stdout.write('\u001b[?25h');
            const runDir = typeof error?.runDir === 'string' ? error.runDir : null;
            if (runDir) {
                this.lastRunDir = runDir;
            }
            const payload = {
                status: 'RUN_FAILED',
                user_status: 'failed',
                command: 'run',
                task,
                project: this.state.project ?? null,
                run_dir: runDir,
                changed_files: [],
                verification: {
                    status: 'skipped',
                    commands: [],
                    skipped_reason: error.message ?? String(error),
                },
                checkpoint: {
                    required: false,
                    available: false,
                    restore_command: null,
                    inspect_command: null,
                },
                evidence: {
                    run_dir: runDir,
                    support_path: runDir,
                    artifacts: [],
                },
                checks: [],
                usage: globalCostTracker.getSessionSummary(),
                errors: [error.message ?? String(error)],
                next: ['Retry after resolving the failure or inspect the run evidence if a run directory was created.'],
            };
            const human = formatRunResultHuman(payload);
            if (runDir) {
                const review = writeHumanSummaryArtifact(runDir, human, [typeof waterfall.getTranscript === 'function' ? waterfall.getTranscript() : '', human].filter(Boolean).join('\n'));
                if (review?.status === 'needs_attention') {
                    console.log(muted('  Output review: target mismatch detected\n'));
                }
            }
            this.updateConversationMemory(payload, task);
            this.appendTurn({
                role: 'assistant',
                ...(this.lastAssistantAnswer ? { answer: this.lastAssistantAnswer } : {}),
                summary: error.message ?? String(error),
                run_dir: runDir,
                target_root: target.targetRoot,
                workspace_root: target.workspaceRoot,
                changed_files: [],
                verification: 'failed',
                next: this.lastAssistantNext,
            });
            console.error(`\n${human}\n`);
        } finally {
            eventStream?.close();
            bus.removeAllListeners();
            this.isRunning = false;
            this.rl.resume();
        }
    }

    // ── Run Summary ───────────────────────────────────────────────────────────

    private printRunSummary(result: any, context: { input?: string; task: string; projectRoot?: string; transcript?: string }): void {
        this.state.lastRunUserStatus = userStatusForRun(String(result.status ?? ''));
        if (context.projectRoot !== undefined) {
            this.state.lastRunTargetRoot = context.projectRoot;
        }
        const payload = buildRunResultPayload(result, {
            task: context.task,
            mode: this.state.mode,
            ...(this.state.project !== undefined ? { project: this.state.project } : {}),
            ...(context.projectRoot !== undefined ? { projectRoot: context.projectRoot } : {}),
            orchestrator: this.state.router,
            ...(this.state.model !== undefined ? { requestedModel: this.state.model } : {}),
        });
        const human = formatRunResultHuman(payload);
        const transcript = [
            context.input ? `You: ${context.input}` : '',
            context.transcript,
            human,
        ].filter(Boolean).join('\n');
        const review = writeHumanSummaryArtifact(result.runDir, human, transcript);
        this.updateConversationMemory(payload, context.task);
        const changedFiles = Array.isArray(payload['changed_files'])
            ? payload['changed_files'].filter((entry): entry is string => typeof entry === 'string')
            : [];
        const verification = payload['verification'] && typeof payload['verification'] === 'object'
            ? String((payload['verification'] as Record<string, unknown>)['status'] ?? '')
            : null;
        this.appendTurn({
            role: 'assistant',
            ...(this.lastAssistantAnswer ? { answer: this.lastAssistantAnswer, summary: this.lastAssistantAnswer } : {}),
            run_dir: result.runDir,
            changed_files: changedFiles,
            verification,
            next: this.lastAssistantNext,
        });
        console.log(`\n${human}\n`);
        if (review?.status === 'needs_attention') {
            console.log(muted('  Output review: target mismatch detected\n'));
        }
    }

    // ── Session Model Resolution ──────────────────────────────────────────────

    private resolveSessionModel(): void {
        if (!this.state.model) return;
        try {
            const resolved = resolveModelByKey({ key: this.state.model });
            this.state.resolvedModelId = resolved.providerModelId;
            this.state = {
                ...this.state,
                ...(resolved.approximateCostPerRunUsd !== undefined
                    ? { approximateCostPerRunUsd: resolved.approximateCostPerRunUsd }
                    : {}),
            };
        } catch (error: any) {
            console.log(accentBright(`\n  Policy Error: ${error.message}`));
            delete (this.state as any).model;
            delete (this.state as any).resolvedModelId;
            delete (this.state as any).approximateCostPerRunUsd;
        }
    }

    // ── History ──────────────────────────────────────────────────────────────

    private showHistory(): void {
        console.log(primary('\n  Command History:'));
        const history = (this.rl as ReadlineWithHistory).history as string[];
        history.slice().reverse().forEach((h, i) => {
            console.log(`    ${muted((i + 1).toString().padStart(3) + '.')} ${h}`);
        });
    }

    // ── Dashboard ────────────────────────────────────────────────────────────

    private showDashboard(): void {
        const stats = globalCostTracker.getSessionSummary();
        const width = getTerminalWidth();

        process.stdout.write('\u001bc'); // clear screen
        process.stdout.write(renderOperatorHeader(this.state));

        console.log(primary(`\n  ${bold('SESSION DASHBOARD')} ${muted('─'.repeat(Math.max(0, width - 22)))}\n`));

        const col1 = 18;
        console.log(`    ${muted(padRight('Active Project', col1))} ${accentBright(this.state.project ?? 'global (auto-detect)')}`);
        console.log(`    ${muted(padRight('Pipeline Mode', col1))} ${accentBright(this.state.mode)}`);
        console.log(`    ${muted(padRight('Active Model', col1))} ${this.state.model ?? muted('auto-selected')}`);

        const tokenIn  = Object.values(stats.modelBreakdown).reduce((s, m) => s + m.inputTokens, 0);
        const tokenOut = Object.values(stats.modelBreakdown).reduce((s, m) => s + m.outputTokens, 0);

        console.log(primary(`\n  ${bold('FINANCIALS')} ${muted('─'.repeat(Math.max(0, width - 15)))}\n`));
        console.log(`    ${muted(padRight('Total Spend', col1))} ${accentBright('$' + stats.totalCostUSD.toFixed(6))}`);
        console.log(`    ${muted(padRight('Tokens In', col1))} ${tokenIn.toLocaleString()}`);
        console.log(`    ${muted(padRight('Tokens Out', col1))} ${tokenOut.toLocaleString()}`);

        console.log(primary(`\n  ${bold('CAPABILITIES')} ${muted('─'.repeat(Math.max(0, width - 17)))}\n`));
        console.log(`    ${muted('✓')} ${dim('Persistence')}  ${muted('enabled (.babel_history)')}`);
        console.log(`    ${muted('✓')} ${dim('Interactive')}  ${muted('enabled (checklist review)')}`);
        console.log(`    ${muted('✓')} ${dim('HUD Waterfall')} ${muted('active (hot-file activity)')}`);

        console.log(muted('\n  Next: /mode verified  /help  /inspect\n'));
    }

    // ── Exit ─────────────────────────────────────────────────────────────────

    private exit(): void {
        delete process.env['BABEL_INTERACTIVE'];
        logUpdate.clear();
        process.stdout.write('\u001b[?25h\n');
        console.log(primary('  Babel session ended. See you next run.\n'));
        process.exit(0);
    }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

export async function startInteractiveSession(
    initialState?: Partial<SessionState>
): Promise<void> {
    const repl = new BabelRepl(initialState);
    await repl.start();
}
