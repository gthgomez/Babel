import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';
import { getSafeEnv } from '../utils/safeEnv.js';

export type BenchmarkScenarioStatus = 'pass' | 'fail' | 'not_implemented';
export type CapabilityStatus = 'implemented' | 'partial' | 'gap' | 'not_started';

export interface BenchmarkCommandExpectation {
  exitCodes?: number[];
  stdoutIncludes?: string[];
  jsonStdout?: boolean;
}

export interface BenchmarkMarketSource {
  vendor: 'claude_code' | 'codex' | 'gemini_cli' | 'babel';
  title: string;
  url: string;
}

export interface BenchmarkScenarioDefinition {
  id: string;
  title: string;
  phase: number;
  category: string;
  matrixDimension: string;
  userScenario: string;
  benchmarkQuestion: string;
  marketBar: string;
  marketSources: BenchmarkMarketSource[];
  targetOutcome: string;
  command?: string[];
  expectation?: BenchmarkCommandExpectation;
  capabilityStatus: CapabilityStatus;
  notes?: string[];
}

export interface BenchmarkScenarioResult {
  id: string;
  title: string;
  phase: number;
  category: string;
  matrix_dimension: string;
  user_scenario: string;
  benchmark_question: string;
  market_bar: string;
  market_sources: BenchmarkMarketSource[];
  target_outcome: string;
  capability_status: CapabilityStatus;
  status: BenchmarkScenarioStatus;
  command: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string | null;
  stderr: string | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  checks: Array<{
    id: string;
    status: 'pass' | 'fail';
    message: string;
  }>;
  notes: string[];
}

export interface ProductBenchmarkReport {
  schema_version: 1;
  benchmark_type: 'babel_cli_product_gap';
  generated_at: string;
  artifact_path: string;
  scorecard_schema_path: string;
  environment: {
    platform: NodeJS.Platform;
    node: string;
    babel_root: string;
    cli_root: string;
    runs_dir: string;
  };
  summary: {
    scenarios: number;
    pass: number;
    fail: number;
    not_implemented: number;
    implemented: number;
    partial: number;
    gap: number;
    not_started: number;
  };
  scenarios: BenchmarkScenarioResult[];
  capability_scorecard: Array<{
    id: string;
    phase: number;
    capability: string;
    status: CapabilityStatus;
    evidence_scenario_ids: string[];
    user_scenario: string;
    benchmark_question: string;
    market_sources: BenchmarkMarketSource[];
    target_outcome: string;
  }>;
}

export interface ProductBenchmarkOptions {
  outputDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: Date;
  scenarios?: BenchmarkScenarioDefinition[];
  readinessGate?: 'fail' | 'off';
}

interface CliInvocation {
  executable: string;
  baseArgs: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;

const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
  /(token\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
  /(secret\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
  /(password\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
];

const MARKET_SOURCES = {
  claudeOverview: {
    vendor: 'claude_code',
    title: 'Claude Code overview',
    url: 'https://docs.anthropic.com/en/docs/claude-code/overview',
  },
  claudeHooks: {
    vendor: 'claude_code',
    title: 'Claude Code hooks',
    url: 'https://docs.anthropic.com/en/docs/claude-code/hooks',
  },
  claudeSubagents: {
    vendor: 'claude_code',
    title: 'Claude Code subagents',
    url: 'https://docs.anthropic.com/en/docs/claude-code/sub-agents',
  },
  codexCodeGeneration: {
    vendor: 'codex',
    title: 'OpenAI code generation and Codex guide',
    url: 'https://platform.openai.com/docs/guides/code-generation',
  },
  codexCi: {
    vendor: 'codex',
    title: 'OpenAI Codex CI getting started',
    url: 'https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started',
  },
  geminiCli: {
    vendor: 'gemini_cli',
    title: 'Gemini CLI overview',
    url: 'https://docs.cloud.google.com/gemini/docs/codeassist/gemini-cli',
  },
  geminiCommands: {
    vendor: 'gemini_cli',
    title: 'Gemini CLI commands',
    url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md',
  },
  geminiExtensions: {
    vendor: 'gemini_cli',
    title: 'Gemini CLI extensions reference',
    url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md',
  },
  babel: {
    vendor: 'babel',
    title: 'Babel local release-readiness gate',
    url: 'local:babel-cli/product-benchmark',
  },
} satisfies Record<string, BenchmarkMarketSource>;

function getCliRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const serviceDir = dirname(currentFile);
  return resolve(serviceDir, '..', '..');
}

function resolveSelfCliInvocation(cliRoot: string): CliInvocation {
  const distEntry = join(cliRoot, 'dist', 'index.js');
  if (existsSync(distEntry)) {
    return {
      executable: process.execPath,
      baseArgs: [distEntry],
    };
  }

  return {
    executable: process.execPath,
    baseArgs: ['--import', 'tsx', join(cliRoot, 'src', 'index.ts')],
  };
}

function appendCliArgs(cli: CliInvocation, args: string[]): string[] {
  return [cli.executable, ...cli.baseArgs, ...args];
}

function liteFeatureScorecardCommand(cliRoot: string, dimension: string): string[] {
  return [
    process.execPath,
    '--import',
    'tsx',
    join(cliRoot, 'scripts', 'score_lite_feature.ts'),
    '--dimension',
    dimension,
    '--json',
  ];
}

function defaultScenarios(cli: CliInvocation): BenchmarkScenarioDefinition[] {
  return [
    {
      id: 'install_path_help',
      title: 'Install path exposes top-level help',
      phase: 0,
      category: 'baseline',
      matrixDimension: 'install_path',
      userScenario:
        'A new user installs or builds Babel and needs to discover the first safe command.',
      benchmarkQuestion:
        'Does top-level help start quickly and point to daily commands without requiring prior Babel knowledge?',
      marketBar:
        'Codex, Gemini CLI, and Claude Code all provide a quick first command discovery path.',
      marketSources: [
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCli,
        MARKET_SOURCES.claudeOverview,
      ],
      targetOutcome: 'Babel help starts reliably and names the daily command surfaces.',
      command: appendCliArgs(cli, ['--help']),
      expectation: {
        exitCodes: [0],
        stdoutIncludes: ['Command Guide:', 'babel run'],
      },
      capabilityStatus: 'implemented',
    },
    {
      id: 'first_run_doctor_json',
      title: 'First-run doctor emits structured JSON',
      phase: 0,
      category: 'baseline',
      matrixDimension: 'first_run_time',
      userScenario:
        'A user wants to know whether this workspace is ready before trusting Babel with code.',
      benchmarkQuestion:
        'Can Babel emit machine-readable readiness diagnostics from a fresh command path?',
      marketBar: 'Market CLIs make environment readiness inspectable before a real task run.',
      marketSources: [
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCli,
        MARKET_SOURCES.claudeOverview,
      ],
      targetOutcome: 'Babel can record workspace readiness as parseable evidence.',
      command: appendCliArgs(cli, ['doctor', '--scope', 'workspace', '--json']),
      expectation: {
        exitCodes: [0, 1],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
      notes: [
        'Exit code 1 is accepted here so an unhealthy workspace still records a baseline artifact.',
      ],
    },
    {
      id: 'first_five_minutes_setup',
      title: 'First-five-minutes setup checklist',
      phase: 1,
      category: 'onboarding',
      matrixDimension: 'first_run_time',
      userScenario:
        'A new user wants one safe command that explains how to install, build, run doctor, and perform a no-mutation probe.',
      benchmarkQuestion:
        'Can Babel show a structured first-run checklist without mutating files or starting a model call?',
      marketBar:
        'Claude Code, Codex, and Gemini CLI all optimize for fast first-run orientation and clear next commands.',
      marketSources: [
        MARKET_SOURCES.claudeOverview,
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCli,
      ],
      targetOutcome:
        'Babel setup emits Windows-first commands for dependency install, build, doctor, and a safe context preview probe.',
      command: appendCliArgs(cli, ['setup', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['first_five_minutes', 'context preview @file README.md'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Setup is read-only and intended as the first local trust-building command before a real task run.',
      ],
    },
    {
      id: 'approval_profile_status',
      title: 'Approval profile ergonomics are inspectable',
      phase: 0,
      category: 'baseline',
      matrixDimension: 'tool_approval_ergonomics',
      userScenario:
        'A user wants to inspect or change how much autonomy Babel has before running a task.',
      benchmarkQuestion: 'Can Babel show approval/autonomy state as structured output?',
      marketBar: 'Market CLIs expose approval and autonomy mode state as a user-facing control.',
      marketSources: [
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCli,
        MARKET_SOURCES.claudeOverview,
      ],
      targetOutcome: 'Babel permissions status is machine-readable and repeatable.',
      command: appendCliArgs(cli, ['permissions', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
    },
    {
      id: 'dry_run_safety_status',
      title: 'Dry-run safety state is inspectable',
      phase: 0,
      category: 'baseline',
      matrixDimension: 'file_edit_reliability',
      userScenario: 'A user wants to experiment without accidentally mutating live files.',
      benchmarkQuestion: 'Can Babel show whether mutating tools are live or dry-run/shadowed?',
      marketBar:
        'Safe experimentation requires users to know whether mutations are live or shadowed.',
      marketSources: [
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCli,
        MARKET_SOURCES.claudeOverview,
      ],
      targetOutcome: 'Babel dry status records the effective mutation mode.',
      command: appendCliArgs(cli, ['dry', 'status', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
    },
    {
      id: 'mcp_registry_status',
      title: 'MCP v2 doctor is inspectable',
      phase: 2,
      category: 'external_context',
      matrixDimension: 'mcp_setup_time',
      userScenario:
        'A user connects external context through MCP and needs to diagnose setup without running an agent.',
      benchmarkQuestion:
        'Can Babel report MCP transport, auth, timeout, and schema-readiness state?',
      marketBar:
        'Market CLIs expose MCP configuration, setup diagnostics, resource/prompt discovery, and bounded tool loading.',
      marketSources: [
        MARKET_SOURCES.geminiCli,
        MARKET_SOURCES.claudeOverview,
        MARKET_SOURCES.codexCodeGeneration,
      ],
      targetOutcome:
        'Babel can report configured MCP servers, transport/auth hints, timeout policy, and lazy schema loading without starting a run.',
      command: appendCliArgs(cli, ['mcp', 'doctor', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['schema_policy', 'external_content_policy'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 4 labels MCP resources, prompts, and tool discovery as untrusted external content; HTTP/OAuth remain explicitly later.',
      ],
    },
    {
      id: 'evidence_surface_status',
      title: 'Evidence surface and latest run pointer are inspectable',
      phase: 0,
      category: 'baseline',
      matrixDimension: 'successful_task_completion',
      userScenario:
        'A user has run Babel and needs to find evidence, inspection commands, and latest run state.',
      benchmarkQuestion: 'Can Babel show where evidence lives and how to inspect it?',
      marketBar: 'Serious codebase work needs post-run evidence and resumable inspection surfaces.',
      marketSources: [
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCommands,
        MARKET_SOURCES.claudeOverview,
      ],
      targetOutcome: 'Babel can show evidence commands and the latest run pointer state.',
      command: appendCliArgs(cli, ['evidence', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
    },
    {
      id: 'checkpoint_restore_surface',
      title: 'Checkpoint and restore mistake recovery',
      phase: 1,
      category: 'recovery',
      matrixDimension: 'restore_reliability',
      userScenario: 'A user wants to undo a bad tool mutation without losing unrelated edits.',
      benchmarkQuestion: 'Can Babel list available pre-mutation checkpoints as structured data?',
      marketBar:
        'Gemini-style checkpoint/restore and Claude-style checkpoint/worktree flows set recovery expectations.',
      marketSources: [MARKET_SOURCES.geminiCommands, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Automatic pre-mutation checkpoints with list, inspect, restore, and session resume commands.',
      command: appendCliArgs(cli, ['checkpoint', 'list', '--json']),
      expectation: {
        exitCodes: [0, 1],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
      notes: [
        'Babel exposes checkpoint list/inspect/restore; file_write uses target snapshots and shell_exec/test_run use bounded filesystem-diff restore with inspectable coverage and force-safety warnings.',
      ],
    },
    {
      id: 'session_resume_surface',
      title: 'Session resume command surface',
      phase: 1,
      category: 'recovery',
      matrixDimension: 'restore_reliability',
      userScenario:
        'A user resumes interrupted work and needs continuation commands from the latest run.',
      benchmarkQuestion: 'Can Babel resolve a run id/latest pointer into recovery metadata?',
      marketBar: 'Market CLIs expose resume/restore entry points for interrupted work.',
      marketSources: [MARKET_SOURCES.geminiCommands, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'A run id can be resolved back to evidence, checkpoint, and continuation commands.',
      command: appendCliArgs(cli, ['session', 'resume', 'latest', '--json']),
      expectation: {
        exitCodes: [0, 1],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
      notes: [
        'Exit code 1 is accepted when no latest run exists in a fresh checkout; runs that reach Stage 4 expose a model_context summary.',
      ],
    },
    {
      id: 'checkpoint_restore_full_context',
      title: 'Full model-context checkpoint restore',
      phase: 1,
      category: 'recovery',
      matrixDimension: 'restore_reliability',
      userScenario:
        'A user needs to recover not only files but also the agent context needed to continue.',
      benchmarkQuestion: 'Does Babel expose session/model context through resume surfaces?',
      marketBar:
        'Gemini checkpoint/restore and Claude checkpoint/worktree flows preserve more than file state.',
      marketSources: [MARKET_SOURCES.geminiCommands, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Restore semantics cover file state, executor history, model context, and approval state.',
      command: appendCliArgs(cli, ['session', 'resume', 'latest', '--json']),
      expectation: {
        exitCodes: [0, 1],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
      notes: [
        'Babel persists 10_session_context.json with executor prompt, history, file-read cache, tool log, and QA approval state; exit code 1 is accepted when no latest run exists.',
      ],
    },
    {
      id: 'runtime_plugin_activation',
      title: 'Runtime plugin activation with policy gates',
      phase: 10,
      category: 'extensibility',
      matrixDimension: 'extension_setup_time',
      userScenario:
        'A team wants to extend Babel with local tools or hooks without weakening trust policy.',
      benchmarkQuestion: 'Can Babel diagnose runtime plugin manifests and trust gates?',
      marketBar:
        'Codex, Gemini CLI, and Claude Code all expose plugin, extension, skill, or hook surfaces.',
      marketSources: [
        MARKET_SOURCES.geminiExtensions,
        MARKET_SOURCES.claudeHooks,
        MARKET_SOURCES.codexCodeGeneration,
      ],
      targetOutcome:
        'Plugins can contribute tools, slash commands, MCP bundles, skills, and hooks under explicit trust policy.',
      command: appendCliArgs(cli, ['plugins', 'doctor', '--json']),
      expectation: {
        exitCodes: [0, 1],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 10 keeps plugin trust levels explicit and diagnoses disabled, missing, blocked, and unsafe plugin states before runtime activation.',
      ],
    },
    {
      id: 'plugin_hook_contract',
      title: 'Local-mutating hook contract is inspectable',
      phase: 10,
      category: 'extensibility',
      matrixDimension: 'extension_setup_time',
      userScenario: 'A user wants to inspect a formatting hook before allowing it to mutate files.',
      benchmarkQuestion:
        'Can Babel show hook event, action, and trust level without activating the plugin?',
      marketBar:
        'Extension ecosystems need inspectable hook behavior and trust boundaries before activation.',
      marketSources: [
        MARKET_SOURCES.geminiExtensions,
        MARKET_SOURCES.claudeHooks,
        MARKET_SOURCES.codexCodeGeneration,
      ],
      targetOutcome:
        'The sample format hook exposes local-mutating trust, PostToolUse wiring, and trim_trailing_whitespace behavior as JSON.',
      command: appendCliArgs(cli, ['plugins', 'inspect', 'sample-format-hook', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['local_mutating', 'PostToolUse', 'trim_trailing_whitespace'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Hook execution writes 09_plugin_events.jsonl during runs; this scenario keeps the benchmark read-only by inspecting the manifest contract.',
      ],
    },
    {
      id: 'enterprise_policy_strict_doctor',
      title: 'Strict enterprise policy doctor',
      phase: 11,
      category: 'enterprise',
      matrixDimension: 'enterprise_controls',
      userScenario:
        'An admin wants strict mode to prove Babel is running under explicit managed policy before release.',
      benchmarkQuestion:
        'Can Babel verify strict enterprise controls from a managed policy source?',
      marketBar:
        'Enterprise coding agents expose managed settings, policy controls, telemetry posture, and safety defaults.',
      marketSources: [
        MARKET_SOURCES.claudeOverview,
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.geminiCli,
      ],
      targetOutcome:
        'Strict enterprise doctor passes only with a managed policy and reports tool, MCP, network, model, plugin, telemetry, and redaction controls.',
      command: appendCliArgs(cli, [
        'doctor',
        '--scope',
        'enterprise',
        '--strict-enterprise',
        '--json',
      ]),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: [
          'enterprise_policy.present_for_strict',
          'enterprise_policy.telemetry_opt_in',
          'enterprise_policy.redaction',
        ],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 11 keeps strict enterprise policy opt-in and proves telemetry/redaction controls without changing the personal default path.',
      ],
    },
    {
      id: 'subagent_team_contract',
      title: 'Review-only subagent isolation contract',
      phase: 8,
      category: 'agent_teams',
      matrixDimension: 'parallel_agent_review',
      userScenario:
        'A user wants multiple agents to work on distinct slices without stomping each other.',
      benchmarkQuestion:
        'Can Babel expose agent-team specs and prior runs with write-scope evidence?',
      marketBar: 'Codex and Claude expose subagents/agent teams with isolated responsibilities.',
      marketSources: [MARKET_SOURCES.claudeSubagents, MARKET_SOURCES.codexCodeGeneration],
      targetOutcome:
        'Subagents declare role, task, allowed/disallowed tools, read/write scope, evidence path, and synthesis rules while live subagents remain gated.',
      command: appendCliArgs(cli, ['agents', 'contract', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: [
          'live_subagents_enabled',
          'review_only_agents_cannot_write',
          'per_agent_evidence_path',
        ],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 8 is review-only by default: the deterministic contract exposes evidence requirements and blocks live LLM subagents until future opt-in.',
      ],
    },
    {
      id: 'subagent_mutating_restore_surface',
      title: 'Mutating subagent merge restore surface',
      phase: 9,
      category: 'agent_teams',
      matrixDimension: 'parallel_agent_review',
      userScenario:
        'A lead needs to merge isolated subagent edits only when restore evidence exists.',
      benchmarkQuestion:
        'Does Babel expose a restore command for files changed by an agent-team merge?',
      marketBar:
        'Parallel editing needs explicit merge, conflict refusal, and rollback evidence before live autonomy expands.',
      marketSources: [MARKET_SOURCES.claudeSubagents, MARKET_SOURCES.codexCodeGeneration],
      targetOutcome:
        'Agent-team merge evidence includes a pre-merge snapshot and a visible restore command.',
      command: appendCliArgs(cli, ['agents', 'restore', '--help']),
      expectation: {
        exitCodes: [0],
        stdoutIncludes: ['pre-merge snapshot'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 9 uses isolated copies/worktrees plus merge restore snapshots; live LLM-backed mutating subagents remain gated.',
      ],
    },
    {
      id: 'interactive_recovery_command_parity',
      title: 'Interactive recovery command parity',
      phase: 5,
      category: 'session_ux',
      matrixDimension: 'context_loading',
      userScenario:
        'A daily user needs discoverable interactive commands for recovery and inspection.',
      benchmarkQuestion: 'Does interactive help expose the recovery/session surfaces?',
      marketBar:
        'Market CLIs expose discoverable slash commands for recovery, tools, MCP, plugins, agents, and session state.',
      marketSources: [MARKET_SOURCES.geminiCommands, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Babel REPL help exposes checkpoint, restore, session, and agent team command surfaces.',
      command: appendCliArgs(cli, ['interactive', '--help']),
      expectation: {
        exitCodes: [0],
        stdoutIncludes: [
          'Interactive slash command map:',
          '/checkpoint, /restore, /session',
          '/mcp, /plugins, /plugin, /agents',
        ],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 2 tightens command discoverability across command-specific help and the REPL workflow guide.',
      ],
    },
    {
      id: 'context_injection_preview',
      title: '@file and @directory context injection',
      phase: 5,
      category: 'session_ux',
      matrixDimension: 'context_loading',
      userScenario:
        'A user needs to attach a file or directory to a task without loading the whole repo.',
      benchmarkQuestion: 'Can Babel preview bounded context attachments before a run?',
      marketBar:
        'Market CLIs support lightweight file and directory context attachment from the prompt surface.',
      marketSources: [
        MARKET_SOURCES.geminiCommands,
        MARKET_SOURCES.claudeOverview,
        MARKET_SOURCES.codexCodeGeneration,
      ],
      targetOutcome: '@file/@directory context is git-aware, bounded, and visible in evidence.',
      command: appendCliArgs(cli, ['context', 'preview', '@file', 'README.md', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['attachments'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Context injection resolves inside the project root, skips git-ignored/binary/dependency artifacts, and writes 00_context_injections.json for real runs.',
      ],
    },
    {
      id: 'json_event_stream_surface',
      title: 'Structured JSON event stream surface',
      phase: 5,
      category: 'session_ux',
      matrixDimension: 'ide_handoff',
      userScenario:
        'A UI or IDE bridge needs machine-readable lifecycle events instead of scraping text.',
      benchmarkQuestion:
        'Does Babel expose a stable event stream contract for non-terminal consumers?',
      marketBar:
        'IDE/webview bridges need machine-readable run lifecycle events before a UI is built.',
      marketSources: [
        MARKET_SOURCES.codexCodeGeneration,
        MARKET_SOURCES.claudeOverview,
        MARKET_SOURCES.geminiCli,
      ],
      targetOutcome:
        'Babel exposes a namespaced JSONL event stream hook and a read-only bridge contract for stage, agent, log, result, and error events.',
      command: appendCliArgs(cli, ['events', 'schema', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['babel.event_stream', 'event_schema_version', 'remote_side_effects'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'The event stream uses schema_version 2 envelopes with source, sequence, event_type, and payload fields; Phase 9 adds a read-only schema command for IDE/webview prototypes.',
      ],
    },
    {
      id: 'run_stats_surface',
      title: 'Richer run and session stats',
      phase: 5,
      category: 'session_ux',
      matrixDimension: 'successful_task_completion',
      userScenario:
        'A user wants to understand latency, tool use, cache behavior, and session state after a run.',
      benchmarkQuestion: 'Can Babel derive stats from evidence without starting a new model call?',
      marketBar:
        'Market CLIs expose stats for latency, tools, cache, token use, and session state.',
      marketSources: [MARKET_SOURCES.geminiCommands, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Babel derives waterfall latency, tool counts, cache hits, tokens, cost, and session context from evidence bundles.',
      command: appendCliArgs(cli, ['stats', 'run', 'latest', '--json']),
      expectation: {
        exitCodes: [0, 1],
        jsonStdout: true,
      },
      capabilityStatus: 'implemented',
      notes: [
        'Exit code 1 is accepted when no latest run exists; populated runs expose derived stats from existing evidence artifacts.',
      ],
    },
    {
      id: 'scheduled_automation_surface',
      title: 'Local read-only schedule registry',
      phase: 6,
      category: 'automation',
      matrixDimension: 'automation_reliability',
      userScenario: 'A user wants repeatable local checks without a daemon or surprise mutation.',
      benchmarkQuestion: 'Can Babel list local schedules as structured data?',
      marketBar:
        'Market tools support non-interactive automation, CI, GitHub workflows, or scheduled tasks.',
      marketSources: [
        MARKET_SOURCES.codexCi,
        MARKET_SOURCES.claudeOverview,
        MARKET_SOURCES.geminiCli,
      ],
      targetOutcome: 'Local schedules write resumable evidence without mutating by default.',
      command: appendCliArgs(cli, ['schedule', 'list', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['schedules'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 6C implements a local schedule registry and run-now evidence for read-only/draft jobs only; no daemon or mutating scheduled jobs are enabled.',
      ],
    },
    {
      id: 'mutating_scheduled_automation_gate',
      title: 'Mutating scheduled automation gate',
      phase: 6,
      category: 'automation',
      matrixDimension: 'automation_reliability',
      userScenario:
        'A user wants scheduled mutation only when isolation and explicit opt-in are present.',
      benchmarkQuestion: 'Does the schedule run-now help expose the mutating schedule gate?',
      marketBar:
        'Higher-autonomy scheduled mutation requires isolation, review gates, and explicit merge semantics.',
      marketSources: [MARKET_SOURCES.codexCi, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Scheduled mutating work only runs inside isolated roots and merges reviewed paths explicitly.',
      command: appendCliArgs(cli, ['schedule', 'run-now', '--help']),
      expectation: {
        exitCodes: [0],
        stdoutIncludes: ['--allow-mutate', 'isolated project copy'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Mutating schedule jobs require run-now --allow-mutate and execute in an isolated project copy; daemon/recurrence remains future work.',
      ],
    },
    {
      id: 'ci_review_surface',
      title: 'Read-only CI review evidence',
      phase: 6,
      category: 'automation',
      matrixDimension: 'automation_reliability',
      userScenario: 'A user wants deterministic PR-style review evidence from current changes.',
      benchmarkQuestion: 'Can Babel produce read-only CI review evidence?',
      marketBar: 'Market tools support deterministic CI review output and PR-ready summaries.',
      marketSources: [MARKET_SOURCES.codexCi, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Babel writes deterministic changed-file, risk, test-signal, and PR-draft evidence without mutating the repo.',
      command: appendCliArgs(cli, ['ci', 'review', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['babel_ci_review', 'artifact_path', 'delivery_policy'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 7 adds machine-readable read-only/draft-first delivery policy evidence; CI review writes evidence only under runs/ci-review.',
      ],
    },
    {
      id: 'git_draft_surface',
      title: 'Draft-only Git delivery surfaces',
      phase: 6,
      category: 'automation',
      matrixDimension: 'automation_reliability',
      userScenario:
        'A user wants PR text and commit messaging without committing or touching remotes.',
      benchmarkQuestion: 'Can Babel draft Git/PR delivery metadata as evidence?',
      marketBar:
        'Market tools support Git and PR workflows, but safe local defaults should draft before mutating.',
      marketSources: [MARKET_SOURCES.codexCi, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Babel drafts diff summaries, commit messages, and PR metadata as evidence without committing, pushing, or opening PRs.',
      command: appendCliArgs(cli, ['git', 'pr-draft', '--json']),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['pr_draft', 'git-drafts', 'delivery_policy'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 6B is draft-only: no branch creation, git commit, push, or PR creation is performed.',
      ],
    },
    {
      id: 'git_mutation_gate_surface',
      title: 'Governed Git mutation commands',
      phase: 6,
      category: 'automation',
      matrixDimension: 'automation_reliability',
      userScenario: 'A user wants branch/commit/PR actions only behind explicit mutation gates.',
      benchmarkQuestion:
        'Does Babel expose Git mutation commands with visible remote-gate language?',
      marketBar:
        'Market tools can create branches, commits, and PRs, but serious local agents need explicit side-effect gates.',
      marketSources: [MARKET_SOURCES.codexCi, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Babel exposes local branch/commit mutation with evidence and keeps PR remote creation gated by default.',
      command: appendCliArgs(cli, ['git', '--help']),
      expectation: {
        exitCodes: [0],
        stdoutIncludes: ['branch-create', 'commit-create', 'pr-create', '--allow-remote'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Branch and commit creation are explicit local mutations with artifacts; PR creation remains planned unless --allow-remote is supplied.',
      ],
    },
    {
      id: 'github_ship_workflow_surface',
      title: 'Guarded GitHub ship workflow',
      phase: 6,
      category: 'automation',
      matrixDimension: 'automation_reliability',
      userScenario:
        'A user wants one command to turn verified local work into a branch, commit, push, and draft PR only when hard-stop gates pass.',
      benchmarkQuestion:
        'Does Babel expose a guarded ship command with dry-run and hard-stop language?',
      marketBar:
        'Codex and Claude Code expose GitHub workflows; Babel needs one AGENTS.md-aligned delivery command with evidence and hard stops.',
      marketSources: [MARKET_SOURCES.codexCi, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'Babel documents a single ship workflow that writes evidence and refuses unsafe GitHub delivery conditions.',
      command: appendCliArgs(cli, ['ship', '--help']),
      expectation: {
        exitCodes: [0],
        stdoutIncludes: ['--dry-run', 'Hard stops include', '--verify'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'The ship workflow composes CI review, Git drafts, verification, local commit, push, and draft PR creation behind AGENTS hard-stop checks.',
      ],
    },
    {
      id: 'public_export_dry_run',
      title: 'Public export dry-run safety',
      phase: 11,
      category: 'release',
      matrixDimension: 'public_release_readiness',
      userScenario:
        'A maintainer wants to preview the public export without touching the public repo.',
      benchmarkQuestion: 'Can Babel prove public export planning is non-mutating before release?',
      marketBar:
        'Public release workflows need repeatable validation, scrub checks, and safe preview commands.',
      marketSources: [MARKET_SOURCES.codexCi, MARKET_SOURCES.claudeOverview],
      targetOutcome:
        'The export dry-run validates manifest/source paths, prints planned operations, and performs no writes, deletes, copies, checks, or Git mutations.',
      command: [
        'pwsh',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(BABEL_ROOT, 'tools', 'export-babel-public.ps1'),
        '-DestinationRoot',
        join(tmpdir(), 'babel-public-product-benchmark-dryrun'),
        '-DryRun',
        '-SkipChecks',
      ],
      expectation: {
        exitCodes: [0],
        stdoutIncludes: ['Dry run:', 'No files were written'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Phase 10 adds dry-run coverage to public release validation and product benchmarking while leaving Babel-public untouched.',
      ],
    },
    {
      id: 'lite_plan_mode_scorecard',
      title: 'Lite plan mode on parity fixture',
      phase: 12,
      category: 'daily_worker',
      matrixDimension: 'plan_mode',
      userScenario:
        'A daily user wants read-only planning before a narrow fix on an ordinary repo task.',
      benchmarkQuestion:
        'Does Babel Lite emit PLAN_READY from babel plan on a repeatable parity fixture repo?',
      marketBar:
        'Cursor and Claude Code expose explicit plan/read-only modes before mutating edits.',
      marketSources: [MARKET_SOURCES.claudeOverview, MARKET_SOURCES.codexCodeGeneration],
      targetOutcome:
        'Fixture-based internal scorecard records PLAN_READY on the parity corpus repo.',
      command: liteFeatureScorecardCommand(getCliRoot(), 'plan_mode'),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['"dimension": "plan_mode"', '"status": "pass"'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Fixture-based internal scoring via scripts/score_lite_feature.ts; not external parity evidence.',
      ],
    },
    {
      id: 'lite_parallel_review_scorecard',
      title: 'Lite read-only parallel review scorecard',
      phase: 12,
      category: 'daily_worker',
      matrixDimension: 'parallel_agent_review',
      userScenario:
        'A user wants read-only Spark reviewers on plan/fix tasks without live subagent mutation.',
      benchmarkQuestion: 'Does the Lite parallel review harness pass on fixture repos?',
      marketBar: 'Cursor exposes parallel review/subagent patterns with read-only reviewer lanes.',
      marketSources: [MARKET_SOURCES.claudeSubagents, MARKET_SOURCES.codexCodeGeneration],
      targetOutcome:
        'Fixture harness records read-only Spark review metadata and synthesis evidence.',
      command: liteFeatureScorecardCommand(getCliRoot(), 'parallel_review'),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['"dimension": "parallel_review"', '"status": "pass"'],
      },
      capabilityStatus: 'implemented',
      notes: ['Uses lite-parallel-review fixtures; live competitor parity not measured here.'],
    },
    {
      id: 'lite_checkpoint_ux_scorecard',
      title: 'Lite checkpoint UX after verified fix',
      phase: 12,
      category: 'daily_worker',
      matrixDimension: 'restore_reliability',
      userScenario: 'A user needs machine-readable checkpoint evidence after a verified fix.',
      benchmarkQuestion:
        'Can Babel list checkpoints as JSON immediately after a fixture fix completes?',
      marketBar:
        'Cursor-style checkpoint/restore UX expects visible recovery surfaces after mutation.',
      marketSources: [MARKET_SOURCES.geminiCommands, MARKET_SOURCES.claudeOverview],
      targetOutcome: 'Post-fix checkpoint list JSON is available on the parity fixture repo.',
      command: liteFeatureScorecardCommand(getCliRoot(), 'checkpoint_ux'),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['"dimension": "checkpoint_ux"', '"status": "pass"'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Scores checkpoint list surface only; full restore parity remains separately evidenced.',
      ],
    },
    {
      id: 'lite_verifier_discipline_scorecard',
      title: 'Lite verifier discipline on fixture fix',
      phase: 12,
      category: 'daily_worker',
      matrixDimension: 'successful_task_completion',
      userScenario: 'A user must not see FIX_COMPLETE when project verifiers still fail.',
      benchmarkQuestion:
        'Does babel daily require verifier pass before FIX_COMPLETE on the parity fixture?',
      marketBar:
        'Serious coding agents gate completion on verifier/test evidence, not model confidence alone.',
      marketSources: [MARKET_SOURCES.codexCodeGeneration, MARKET_SOURCES.claudeOverview],
      targetOutcome: 'Fixture scorecard records verifier pass in fix checks before success.',
      command: liteFeatureScorecardCommand(getCliRoot(), 'verifier_discipline'),
      expectation: {
        exitCodes: [0],
        jsonStdout: true,
        stdoutIncludes: ['"dimension": "verifier_discipline"', '"status": "pass"'],
      },
      capabilityStatus: 'implemented',
      notes: [
        'Offline_demo fixture scope; arbitrary-repo verifier discipline still YELLOW elsewhere.',
      ],
    },
  ];
}

function toArtifactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '$1[REDACTED]'),
    value,
  );
}

function limitOutput(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const redacted = redact(value);
  const bytes = Buffer.byteLength(redacted, 'utf8');
  if (bytes <= maxBytes) {
    return { text: redacted, truncated: false };
  }

  const buffer = Buffer.from(redacted, 'utf8').subarray(0, maxBytes);
  return {
    text: `${buffer.toString('utf8')}\n...[truncated at ${maxBytes} bytes]`,
    truncated: true,
  };
}

function formatCommand(command: string[]): string {
  return command
    .map((part) => (part.includes(' ') ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ');
}

function checkJsonStdout(stdout: string): { ok: boolean; message: string } {
  try {
    JSON.parse(stdout);
    return { ok: true, message: 'stdout parsed as JSON' };
  } catch (error: unknown) {
    return {
      ok: false,
      message: `stdout was not parseable JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function runScenario(
  scenario: BenchmarkScenarioDefinition,
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    cliRoot: string;
  },
): BenchmarkScenarioResult {
  if (!scenario.command) {
    return {
      id: scenario.id,
      title: scenario.title,
      phase: scenario.phase,
      category: scenario.category,
      matrix_dimension: scenario.matrixDimension,
      user_scenario: scenario.userScenario,
      benchmark_question: scenario.benchmarkQuestion,
      market_bar: scenario.marketBar,
      market_sources: scenario.marketSources,
      target_outcome: scenario.targetOutcome,
      capability_status: scenario.capabilityStatus,
      status: 'not_implemented',
      command: null,
      duration_ms: null,
      exit_code: null,
      timed_out: false,
      stdout: null,
      stderr: null,
      stdout_truncated: false,
      stderr_truncated: false,
      checks: [],
      notes: scenario.notes ?? [],
    };
  }

  const [executable, ...args] = scenario.command;
  if (!executable) {
    throw new Error(`Scenario ${scenario.id} has an empty command.`);
  }

  const started = performance.now();
  const result = spawnSync(executable, args, {
    cwd: options.cliRoot,
    env: {
      ...getSafeEnv(),
      BABEL_ROOT,
      BABEL_RUNS_DIR,
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const durationMs = performance.now() - started;

  const stdout = limitOutput(result.stdout ?? '', options.maxOutputBytes);
  const stderr = limitOutput(result.stderr ?? '', options.maxOutputBytes);
  const exitCode = result.status ?? (result.signal ? 1 : 0);
  const checks: BenchmarkScenarioResult['checks'] = [];

  const expectedExitCodes = scenario.expectation?.exitCodes ?? [0];
  const exitOk = expectedExitCodes.includes(exitCode);
  checks.push({
    id: 'exit_code',
    status: exitOk ? 'pass' : 'fail',
    message: `exit code ${exitCode}; expected ${expectedExitCodes.join(', ')}`,
  });

  for (const expectedText of scenario.expectation?.stdoutIncludes ?? []) {
    const found = (result.stdout ?? '').includes(expectedText);
    checks.push({
      id: `stdout_includes:${expectedText}`,
      status: found ? 'pass' : 'fail',
      message: found
        ? `stdout included "${expectedText}"`
        : `stdout did not include "${expectedText}"`,
    });
  }

  if (scenario.expectation?.jsonStdout === true) {
    const jsonCheck = checkJsonStdout(result.stdout ?? '');
    checks.push({
      id: 'stdout_json',
      status: jsonCheck.ok ? 'pass' : 'fail',
      message: jsonCheck.message,
    });
  }

  if (result.error) {
    checks.push({
      id: 'spawn_error',
      status: 'fail',
      message: result.error.message,
    });
  }

  const status: BenchmarkScenarioStatus = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : 'pass';

  return {
    id: scenario.id,
    title: scenario.title,
    phase: scenario.phase,
    category: scenario.category,
    matrix_dimension: scenario.matrixDimension,
    user_scenario: scenario.userScenario,
    benchmark_question: scenario.benchmarkQuestion,
    market_bar: scenario.marketBar,
    market_sources: scenario.marketSources,
    target_outcome: scenario.targetOutcome,
    capability_status: scenario.capabilityStatus,
    status,
    command: formatCommand(scenario.command),
    duration_ms: Number(durationMs.toFixed(3)),
    exit_code: exitCode,
    timed_out: result.error?.name === 'ETIMEDOUT',
    stdout: stdout.text,
    stderr: stderr.text,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
    checks,
    notes: scenario.notes ?? [],
  };
}

function runReadinessCommand(
  command: string[],
  options: { cliRoot: string; maxOutputBytes: number; id: string },
): BenchmarkScenarioResult['checks'][number] {
  const [executable, ...args] = command;
  if (!executable) {
    return {
      id: options.id,
      status: 'fail',
      message: 'readiness command was empty',
    };
  }

  const result = spawnSync(executable, args, {
    cwd: options.cliRoot,
    env: {
      ...getSafeEnv(),
      BABEL_ROOT,
      BABEL_RUNS_DIR,
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf8',
    timeout: READINESS_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = limitOutput(
    `${result.stdout ?? ''}${result.stderr ?? ''}`,
    options.maxOutputBytes,
  ).text.trim();
  const exitCode = result.status ?? (result.signal ? 1 : 0);
  return {
    id: options.id,
    status: exitCode === 0 ? 'pass' : 'fail',
    message:
      exitCode === 0
        ? `${formatCommand(command)} passed`
        : `${formatCommand(command)} failed with exit code ${exitCode}${output ? `: ${output}` : ''}`,
  };
}

function buildReadinessGateScenario(options: {
  cliRoot: string;
  maxOutputBytes: number;
  cliInvocation: CliInvocation;
}): BenchmarkScenarioResult {
  const started = performance.now();
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const typecheck = runReadinessCommand([npmExecutable, 'run', 'typecheck'], {
    ...options,
    id: 'release_readiness.source_typecheck',
  });
  const doctor = runReadinessCommand(
    appendCliArgs(options.cliInvocation, ['doctor', '--scope', 'all', '--json']),
    { ...options, id: 'release_readiness.doctor_all' },
  );
  const durationMs = performance.now() - started;
  const checks: BenchmarkScenarioResult['checks'] = [typecheck, doctor];

  return {
    id: 'release_readiness_gate',
    title: 'Release readiness gate',
    phase: 0,
    category: 'release',
    matrix_dimension: 'release_readiness',
    user_scenario:
      'A maintainer needs the product benchmark to fail when source or workspace readiness is unhealthy.',
    benchmark_question:
      'Does the product benchmark refuse a green result when source typecheck or doctor readiness is red?',
    market_bar:
      'A credible release benchmark must include build/source health and workspace diagnostics, not only command-surface smoke tests.',
    market_sources: [MARKET_SOURCES.babel],
    target_outcome: 'Product benchmark fails when source typecheck or doctor --scope all fails.',
    capability_status: 'implemented',
    status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    command: 'release readiness: npm run typecheck; doctor --scope all',
    duration_ms: Number(durationMs.toFixed(3)),
    exit_code: checks.some((check) => check.status === 'fail') ? 1 : 0,
    timed_out: false,
    stdout: JSON.stringify(
      { checks: checks.map((check) => ({ id: check.id, status: check.status })) },
      null,
      2,
    ),
    stderr: null,
    stdout_truncated: false,
    stderr_truncated: false,
    checks,
    notes: [
      'This gate intentionally ties product benchmark status to release readiness so dist/source drift and doctor failures cannot be masked by passing command-surface scenarios.',
    ],
  };
}

function summarize(scenarios: BenchmarkScenarioResult[]): ProductBenchmarkReport['summary'] {
  const summary: ProductBenchmarkReport['summary'] = {
    scenarios: scenarios.length,
    pass: 0,
    fail: 0,
    not_implemented: 0,
    implemented: 0,
    partial: 0,
    gap: 0,
    not_started: 0,
  };

  for (const scenario of scenarios) {
    summary[scenario.status] += 1;
    summary[scenario.capability_status] += 1;
  }

  return summary;
}

function buildCapabilityScorecard(
  scenarios: BenchmarkScenarioResult[],
): ProductBenchmarkReport['capability_scorecard'] {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    phase: scenario.phase,
    capability: scenario.title,
    status: scenario.capability_status,
    evidence_scenario_ids: [scenario.id],
    user_scenario: scenario.user_scenario,
    benchmark_question: scenario.benchmark_question,
    market_sources: scenario.market_sources,
    target_outcome: scenario.target_outcome,
  }));
}

export function runProductBenchmark(options: ProductBenchmarkOptions = {}): ProductBenchmarkReport {
  const cliRoot = getCliRoot();
  const now = options.now ?? new Date();
  const outputDir = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timestamp = toArtifactTimestamp(now);
  const artifactPath = join(outputDir, `product-gap-${timestamp}.json`);
  const scorecardSchemaPath = join(
    BABEL_ROOT,
    'docs',
    'research',
    'market-research',
    'product-scorecard.schema.json',
  );
  const cliInvocation = resolveSelfCliInvocation(cliRoot);
  const scenarioDefinitions = options.scenarios ?? defaultScenarios(cliInvocation);

  mkdirSync(outputDir, { recursive: true });

  const scenarios = scenarioDefinitions.map((scenario) =>
    runScenario(scenario, {
      timeoutMs,
      maxOutputBytes,
      cliRoot,
    }),
  );
  if (options.readinessGate !== 'off') {
    scenarios.unshift(buildReadinessGateScenario({ cliRoot, maxOutputBytes, cliInvocation }));
  }

  const report: ProductBenchmarkReport = {
    schema_version: 1,
    benchmark_type: 'babel_cli_product_gap',
    generated_at: now.toISOString(),
    artifact_path: artifactPath,
    scorecard_schema_path: scorecardSchemaPath,
    environment: {
      platform: process.platform,
      node: process.version,
      babel_root: BABEL_ROOT,
      cli_root: cliRoot,
      runs_dir: BABEL_RUNS_DIR,
    },
    summary: summarize(scenarios),
    scenarios,
    capability_scorecard: buildCapabilityScorecard(scenarios),
  };

  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return report;
}

export function formatProductBenchmarkHuman(report: ProductBenchmarkReport): string {
  const lines: string[] = [];
  lines.push('Babel Product Benchmark');
  lines.push(`Artifact: ${report.artifact_path}`);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push(`Scenarios: ${report.summary.scenarios}`);
  lines.push(
    `Executable pass/fail: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.not_implemented} not implemented`,
  );
  lines.push(
    `Capability baseline: ${report.summary.implemented} implemented, ${report.summary.partial} partial, ${report.summary.gap} gap, ${report.summary.not_started} not started`,
  );
  lines.push('');
  for (const scenario of report.scenarios) {
    const duration =
      scenario.duration_ms === null ? '' : ` (${scenario.duration_ms.toFixed(1)} ms)`;
    lines.push(`${scenario.status.toUpperCase().padEnd(15)} ${scenario.id}${duration}`);
  }
  return lines.join('\n');
}
