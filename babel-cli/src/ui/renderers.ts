import { buildStageDescriptors, renderStageTimeline, renderStageSection } from './timeline.js';
import { renderSection, renderSectionHeader } from './sections.js';
import { renderStatusRows, type StatusRow, type StatusRowsOptions } from './statusLine.js';
import {
  renderCheckRows,
  renderOrderedList,
  type CheckRow,
  type CheckRowsOptions,
} from './tables.js';
import { renderProgressLabel, type ProgressLabelOptions } from './progress.js';
import { renderBadge } from './badges.js';
import {
  accentBright,
  muted,
  primary,
  warning,
  accentBlue,
  dim,
  getEffectiveTerminalWidth,
  humanizeModelId,
} from './theme.js';

// ── Types ───────────────────────────────────────────────────────────

export interface RunPreludeContext {
  mode?: string | undefined;
  router?: string | undefined;
  task: string;
  project?: string | undefined;
  model?: string | undefined;
  tier?: string | undefined;
  executionProfile?: string | undefined;
  runDir: string;
  stageStates?: string[] | undefined;
  showStatus?: boolean | undefined;
}

export interface RoutingManifest {
  target_project?: string;
  analysis?: { task_category?: string };
  instruction_stack?: {
    domain_id?: string;
    model_adapter_id?: string;
    pipeline_stage_ids?: string[];
  };
  prompt_manifest?: unknown[];
}

export interface PlanData {
  plan_type?: string;
  minimal_action_set?: Array<{ description?: string; target?: string }>;
  task_summary?: string;
}

export interface QaVerdict {
  verdict: string;
  overall_confidence?: number;
  failure_count?: number;
  failures?: Array<{ tag: string; condition: string }>;
}

export interface ResultData {
  status: string;
  runDir: string;
  plan?: PlanData;
  manifest?: { analysis?: { pipeline_mode?: string } };
  usageSummary: {
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    modelBreakdown?: Record<string, unknown>;
  };
}

export interface DoctorCheck {
  section: string;
  status: string;
  title: string;
  message: string;
  details?: string[];
  fixHint?: string;
}

export interface DoctorResult {
  workspaceRoot: string;
  mode: string;
  scope: string;
  status: string;
  checks: DoctorCheck[];
}

export interface ResumeRow {
  label: string;
  value: string | number;
}

export interface DryRunState {
  persisted: boolean | null;
  sessionOverride: boolean | null;
  effective: boolean;
  runtimeFlagsPath: string;
}

export interface OperatorHeaderState {
  lastRunUserStatus?: string | undefined;
  project?: string | undefined | null;
  resolvedModelId?: string | undefined | null;
  model?: string | undefined | null;
  mode?: string | undefined | null;
  turnCount?: number | undefined;
  router?: string | undefined;
  approximateCostPerRunUsd?: number | undefined;
  compactMode?: 'on' | 'off' | undefined;
  timestamp?: string | undefined;
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatVisibleMode(mode: string): string {
  if (mode === 'plan') return 'Plan';
  if (mode === 'deep') return 'Deep';
  if (mode === 'chat') return 'Chat';
  return 'Chat';
}

function formatUsd(value: number): string {
  return `$${Number(value ?? 0).toFixed(4)}`;
}

function formatInteger(value: number): string {
  return Number(value ?? 0).toLocaleString('en-US');
}

// ── Renderers ───────────────────────────────────────────────────────

export function renderProductBanner(title: string, subtitle = ''): string {
  return [
    '',
    `${accentBright('BABEL')} ${subtitle ? muted(`· ${subtitle}`) : ''}`,
    primary(String(title).trim()),
    '',
  ].join('\n');
}

export function renderHelpPanel(title: string, lines: string[], metadata = ''): string {
  const body = lines.map((line) => `  ${line}`);
  return renderSection(title, body, metadata);
}

export function renderRunPrelude(context: RunPreludeContext): string {
  const visibleMode = formatVisibleMode(context.mode ?? 'deep');
  const metadata = `${visibleMode} · ${context.router ?? 'v9'}`;
  const statusRows = renderStatusRows([
    { label: 'Task', value: context.task },
    { label: 'Project', value: context.project ?? '(auto-detect)' },
    { label: 'Mode', value: visibleMode, tone: 'accent' },
    { label: 'Router', value: context.router ?? 'v9', tone: 'accent' },
    { label: 'Model', value: context.model ?? '(route-selected)' },
    { label: 'Tier', value: context.tier ?? 'policy default' },
    { label: 'Execution Profile', value: context.executionProfile ?? 'safe_repo' },
    { label: 'Run ID', value: context.runDir },
  ]);
  const stages = buildStageDescriptors(
    context.stageStates ?? ['ACTIVE', 'PENDING', 'PENDING', 'PENDING'],
  );
  const blocks: string[] = [];

  if (context.showStatus !== false) {
    blocks.push(renderSection('STATUS', [statusRows], metadata));
    blocks.push('');
  }
  blocks.push(renderSection('PIPELINE', [renderStageTimeline(stages)], 'layered flow'));
  return blocks.join('\n');
}

export { renderStageSection };

export function renderRoutingSummary(manifest: RoutingManifest): string {
  const rows = renderStatusRows([
    { label: 'Project', value: manifest.target_project ?? 'global' },
    { label: 'Category', value: manifest.analysis?.task_category ?? 'unknown' },
    { label: 'Domain', value: manifest.instruction_stack?.domain_id ?? 'n/a', tone: 'accent' },
    { label: 'Adapter', value: manifest.instruction_stack?.model_adapter_id ?? 'n/a' },
    {
      label: 'Stages',
      value: (manifest.instruction_stack?.pipeline_stage_ids ?? []).join(', ') || '(none)',
    },
    { label: 'Manifest', value: `${manifest.prompt_manifest?.length ?? 0} prompt file(s)` },
  ]);
  return renderSection('ROUTING', [rows], 'resolved instruction stack');
}

export function renderPlanSummary(plan: PlanData): string {
  const stepDescriptions = (plan.minimal_action_set ?? [])
    .slice(0, 5)
    .map((step) => step.description ?? step.target ?? JSON.stringify(step));
  const blocks: string[] = [
    renderStatusRows([
      { label: 'Plan Type', value: plan.plan_type ?? 'IMPLEMENTATION_PLAN', tone: 'accent' },
      { label: 'Steps', value: String(plan.minimal_action_set?.length ?? 0) },
      { label: 'Objective', value: plan.task_summary ?? '(missing)' },
    ]),
  ];
  if (stepDescriptions.length > 0) {
    blocks.push('');
    blocks.push(renderOrderedList(stepDescriptions));
  }
  return renderSection('PLAN', blocks, 'planner output');
}

export function renderQaSummary(verdict: QaVerdict): string {
  const failures =
    verdict.failures?.slice(0, 5).map((failure) => `[${failure.tag}] ${failure.condition}`) ?? [];
  const blocks: string[] = [
    renderStatusRows([
      {
        label: 'Verdict',
        value: verdict.verdict,
        tone: verdict.verdict === 'PASS' ? undefined : 'accent',
      },
      { label: 'Confidence', value: `${verdict.overall_confidence ?? 'n/a'}/5` },
      { label: 'Failures', value: String(verdict.failure_count ?? 0) },
    ]),
  ];
  if (failures.length > 0) {
    blocks.push('');
    blocks.push(renderOrderedList(failures));
  }
  return renderSection('QA', blocks, verdict.verdict === 'PASS' ? 'gate passed' : 'gate rejected');
}

export function renderExecutionSummary(plan: PlanData, isDryRun: boolean): string {
  return renderSection(
    'EXECUTION',
    [
      renderStatusRows([
        { label: 'Steps', value: String(plan.minimal_action_set?.length ?? 0) },
        { label: 'Mode', value: isDryRun ? 'dry-run executor' : 'live executor', tone: 'accent' },
        { label: 'Plan Type', value: plan.plan_type ?? 'IMPLEMENTATION_PLAN' },
      ]),
    ],
    'tool phase',
  );
}

export function renderResultSummary(result: ResultData, mode?: string): string {
  const statusBadge = renderBadge(
    result.status === 'COMPLETE'
      ? 'PASS'
      : result.status === 'EXECUTOR_HALTED' || result.status === 'QA_REJECTED_MAX_LOOPS'
        ? 'FAIL'
        : 'BLOCKED',
  );
  const usageSummary = result.usageSummary ?? {
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
  };
  return renderSection(
    'RESULT',
    [
      renderStatusRows([
        { label: 'Status', value: result.status, badge: statusBadge },
        {
          label: 'Mode',
          value: mode ?? result.manifest?.analysis?.pipeline_mode ?? 'unknown',
        },
        { label: 'Bundle', value: result.runDir },
        ...(result.plan
          ? [
              {
                label: 'Steps' as const,
                value: String(result.plan.minimal_action_set?.length ?? 0),
              },
            ]
          : []),
        { label: 'Tokens', value: formatInteger(usageSummary.totalTokens) },
        { label: 'Cost', value: formatUsd(usageSummary.totalCostUSD) },
      ]),
      '',
      renderStatusRows([
        { label: 'Prompt', value: formatInteger(usageSummary.totalInputTokens) },
        { label: 'Completion', value: formatInteger(usageSummary.totalOutputTokens) },
        { label: 'Models', value: String(Object.keys(usageSummary.modelBreakdown ?? {}).length) },
      ]),
    ],
    'final state',
  );
}

export function renderWarningPanel(lines: string[], metadata = ''): string {
  return renderSection(
    'WARNING',
    lines.map((line) => `  ${line}`),
    metadata,
  );
}

export function renderErrorPanel(
  errorKind: string,
  message: string,
  nextHint: string | null = null,
): string {
  const lines = [`${warning('✖')} ${accentBright(errorKind)}`, `  ${muted(message)}`];
  if (nextHint) {
    lines.push('');
    lines.push(`  ${dim('Next:')} ${accentBlue(nextHint)}`);
  }
  return renderSection('ERROR', lines, 'error panel');
}

export function renderPlanModeWarning(): string {
  const body = [
    `${warning('⚠')} ${warning('PLAN MODE ACTIVE')}`,
    `${muted('file_write, shell_exec are')} ${accentBright('BLOCKED')}${muted('.')}`,
    `${muted("Switch back with '")}${accentBlue('/mode chat')}${muted("' when you want the normal action path.")}`,
  ];
  return renderWarningPanel(body, 'read-only safety gate');
}

export function renderDoctorSummary(result: DoctorResult, verbose: boolean): string {
  const lines: string[] = [
    renderProductBanner('Doctor', 'workspace integrity and runtime readiness'),
    renderSection(
      'STATUS',
      [
        renderStatusRows([
          { label: 'Workspace', value: result.workspaceRoot },
          { label: 'Mode', value: result.mode, tone: 'accent' },
          { label: 'Scope', value: result.scope },
          {
            label: 'Overall',
            value: String(result.status).toUpperCase(),
            badge: renderBadge(result.status.toUpperCase()),
          },
        ]),
      ],
      'diagnostic summary',
    ),
    '',
  ];

  const sectionOrder = [
    'Workspace',
    'Repo Map',
    'Runtime',
    'Resolution',
    'Legacy Path Drift',
    'Export',
  ];

  for (const section of sectionOrder) {
    const sectionChecks = result.checks.filter((check) => check.section === section);
    if (sectionChecks.length === 0) continue;

    lines.push(renderSectionHeader(section, `${sectionChecks.length} check(s)`));
    lines.push(
      renderCheckRows(
        sectionChecks.map((check) => ({
          status: check.status.toUpperCase(),
          label: check.title,
          detail: check.message,
        })),
      ),
    );

    if (verbose) {
      for (const check of sectionChecks) {
        for (const detail of check.details ?? []) {
          lines.push(`    ${muted('·')} ${detail}`);
        }
        if (check.fixHint) {
          lines.push(`    ${muted('Hint')} ${check.fixHint}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function renderResumeSummary(title: string, rows: StatusRow[], metadata = ''): string {
  return renderSection(title, [renderStatusRows(rows)], metadata);
}

export function renderDryRunSummary(state: DryRunState): string {
  const persisted =
    state.persisted === null ? '(unset; defaults to dry-run)' : state.persisted ? 'on' : 'off';
  const sessionOverride =
    state.sessionOverride === null ? '(none)' : state.sessionOverride ? 'on' : 'off';
  const effective = state.effective ? 'on' : 'off';
  const modeDetail = state.effective ? 'dry-run executor' : 'live executor via sandbox';

  return [
    renderProductBanner('Dry Mode', 'executor safety control'),
    renderSection(
      'STATUS',
      [
        renderStatusRows([
          { label: 'Effective', value: effective, tone: 'accent' },
          { label: 'Behavior', value: modeDetail },
          { label: 'Persisted Default', value: persisted },
          { label: 'Session Override', value: sessionOverride },
          { label: 'Config', value: state.runtimeFlagsPath },
        ]),
      ],
      'runtime toggle',
    ),
  ].join('\n');
}

export { renderProgressLabel };

/**
 * Renders a compact, premium header for the Babel REPL.
 */
export function renderOperatorHeader(state: Record<string, unknown>): string {
  const userStatus: string = (state.lastRunUserStatus as string) ?? 'ready';
  // Show [READY] for fresh/ready state — a positive status, not a pending warning
  const badgeStatus = userStatus === 'ready' ? 'READY' : userStatus.toUpperCase();
  const statusBadge = renderBadge(badgeStatus);
  const project = state.project ? accentBright(state.project as string) : muted('global');
  const currentMode = (state.mode as string)?.toLowerCase() ?? 'chat';
  const modelDisplay = state.model
    ? accentBlue(humanizeModelId(state.model as string))
    : muted('Qwen 3 32B');
  const mode = state.mode ? accentBright((state.mode as string).toUpperCase()) : muted('CHAT');
  const turnInfo =
    typeof state.turnCount === 'number' && state.turnCount > 0
      ? `${muted('·')} ${dim('turn ' + state.turnCount)}`
      : '';

  const width = getEffectiveTerminalWidth();
  // Lighter separator: dimmed dotted rule — less visual weight than solid ─
  const separator = dim('╌'.repeat(width));

  return [
    '',
    `${accentBright('BABEL')} ${muted('·')} ${statusBadge} ${muted('·')} ${mode} ${muted('·')} ${project} ${muted('·')} ${modelDisplay}${turnInfo ? ` ${turnInfo}` : ''}`,
    separator,
    '',
  ].join('\n');
}
