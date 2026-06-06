import { buildStageDescriptors, renderStageTimeline, renderStageSection } from './timeline.js';
import { renderSection, renderSectionHeader } from './sections.js';
import { renderStatusRows } from './statusLine.js';
import { renderCheckRows, renderOrderedList } from './tables.js';
import { renderProgressLabel } from './progress.js';
import { renderBadge } from './badges.js';
import { accentBright, muted, primary, warning, accentBlue, getTerminalWidth, dim } from './theme.js';
export function renderProductBanner(title, subtitle = '') {
    const lines = [
        '',
        `${accentBright('BABEL')} ${subtitle ? muted(`· ${subtitle}`) : ''}`,
        primary(String(title).trim()),
        '',
    ];
    return lines.join('\n');
}
export function renderHelpPanel(title, lines, metadata = '') {
    const body = lines.map(line => `  ${line}`);
    return renderSection(title, body, metadata);
}
export function renderRunPrelude(context) {
    const metadata = `${context.mode ?? 'verified'} · ${context.router ?? 'v9'}`;
    const statusRows = renderStatusRows([
        { label: 'Task', value: context.task },
        { label: 'Project', value: context.project ?? '(auto-detect)' },
        { label: 'Mode', value: context.mode ?? 'verified', tone: 'accent' },
        { label: 'Router', value: context.router ?? 'v9', tone: 'accent' },
        { label: 'Model', value: context.model ?? '(route-selected)' },
        { label: 'Tier', value: context.tier ?? 'policy default' },
        { label: 'Execution Profile', value: context.executionProfile ?? 'safe_repo' },
        { label: 'Run ID', value: context.runDir },
    ]);
    const stages = buildStageDescriptors(context.stageStates ?? ['ACTIVE', 'PENDING', 'PENDING', 'PENDING']);
    const blocks = [];

    if (context.showStatus !== false) {
        blocks.push(renderSection('STATUS', [statusRows], metadata));
        blocks.push('');
    }

    blocks.push(renderSection('PIPELINE', [renderStageTimeline(stages)], 'layered flow'));

    return blocks.join('\n');
}
export { renderStageSection };
export function renderRoutingSummary(manifest) {
    const rows = renderStatusRows([
        { label: 'Project', value: manifest.target_project ?? 'global' },
        { label: 'Category', value: manifest.analysis?.task_category ?? 'unknown' },
        { label: 'Domain', value: manifest.instruction_stack?.domain_id ?? 'n/a', tone: 'accent' },
        { label: 'Adapter', value: manifest.instruction_stack?.model_adapter_id ?? 'n/a' },
        { label: 'Stages', value: (manifest.instruction_stack?.pipeline_stage_ids ?? []).join(', ') || '(none)' },
        { label: 'Manifest', value: `${manifest.prompt_manifest?.length ?? 0} prompt file(s)` },
    ]);
    return renderSection('ROUTING', [rows], 'resolved instruction stack');
}
export function renderPlanSummary(plan) {
    const stepDescriptions = (plan.minimal_action_set ?? []).slice(0, 5).map((step) => step.description ?? step.target ?? JSON.stringify(step));
    const blocks = [
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
export function renderQaSummary(verdict) {
    const failures = verdict.failures?.slice(0, 5).map((failure) => `[${failure.tag}] ${failure.condition}`) ?? [];
    const blocks = [
        renderStatusRows([
            { label: 'Verdict', value: verdict.verdict, tone: verdict.verdict === 'PASS' ? undefined : 'accent' },
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
export function renderExecutionSummary(plan, isDryRun) {
    return renderSection('EXECUTION', [
        renderStatusRows([
            { label: 'Steps', value: String(plan.minimal_action_set?.length ?? 0) },
            { label: 'Mode', value: isDryRun ? 'dry-run executor' : 'live executor', tone: 'accent' },
            { label: 'Plan Type', value: plan.plan_type ?? 'IMPLEMENTATION_PLAN' },
        ]),
    ], 'tool phase');
}
function formatUsd(value) {
    return `$${Number(value ?? 0).toFixed(4)}`;
}

function formatInteger(value) {
    return Number(value ?? 0).toLocaleString('en-US');
}

export function renderResultSummary(result, mode) {
    const statusBadge = renderBadge(result.status === 'COMPLETE' ? 'PASS' : result.status === 'EXECUTOR_HALTED' || result.status === 'QA_REJECTED_MAX_LOOPS' ? 'FAIL' : 'BLOCKED');
    const usageSummary = result.usageSummary ?? {
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
    };
    return renderSection('RESULT', [
        renderStatusRows([
            { label: 'Status', value: result.status, badge: statusBadge },
            { label: 'Mode', value: mode ?? result.manifest?.analysis?.pipeline_mode ?? 'unknown' },
            { label: 'Bundle', value: result.runDir },
            ...(result.plan ? [{ label: 'Steps', value: String(result.plan.minimal_action_set?.length ?? 0) }] : []),
            { label: 'Tokens', value: formatInteger(usageSummary.totalTokens) },
            { label: 'Cost', value: formatUsd(usageSummary.totalCostUSD) },
        ]),
        '',
        renderStatusRows([
            { label: 'Prompt', value: formatInteger(usageSummary.totalInputTokens) },
            { label: 'Completion', value: formatInteger(usageSummary.totalOutputTokens) },
            { label: 'Models', value: String(Object.keys(usageSummary.modelBreakdown ?? {}).length) },
        ]),
    ], 'final state');
}
export function renderWarningPanel(lines, metadata = '') {
    return renderSection('WARNING', lines.map(line => `  ${line}`), metadata);
}
export function renderPlanModeWarning() {
    const body = [
        `${warning('⚠')} ${warning('PLANNING MODE ACTIVE')}`,
        `${muted('file_write, shell_exec are')} ${accentBright('BLOCKED')}${muted('.')}`,
        `${muted("Use '")}${accentBlue('babel mode act')}${muted("' to unlock.")}`,
    ];
    return renderWarningPanel(body, 'read-only safety gate');
}
export function renderDoctorSummary(result, verbose) {
    const lines = [
        renderProductBanner('Doctor', 'workspace integrity and runtime readiness'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Workspace', value: result.workspaceRoot },
                { label: 'Mode', value: result.mode, tone: 'accent' },
                { label: 'Scope', value: result.scope },
                { label: 'Overall', value: String(result.status).toUpperCase(), badge: renderBadge(result.status.toUpperCase()) },
            ]),
        ], 'diagnostic summary'),
        '',
    ];
    const sectionOrder = ['Workspace', 'Repo Map', 'Runtime', 'Resolution', 'Legacy Path Drift', 'Export'];
    for (const section of sectionOrder) {
        const sectionChecks = result.checks.filter((check) => check.section === section);
        if (sectionChecks.length === 0)
            continue;
        lines.push(renderSectionHeader(section, `${sectionChecks.length} check(s)`));
        lines.push(renderCheckRows(sectionChecks.map((check) => ({
            status: check.status.toUpperCase(),
            label: check.title,
            detail: check.message,
        }))));
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
export function renderResumeSummary(title, rows, metadata = '') {
    return renderSection(title, [renderStatusRows(rows)], metadata);
}
export function renderDryRunSummary(state) {
    const persisted = state.persisted === null ? '(unset; defaults to dry-run)' : state.persisted ? 'on' : 'off';
    const sessionOverride = state.sessionOverride === null ? '(none)' : state.sessionOverride ? 'on' : 'off';
    const effective = state.effective ? 'on' : 'off';
    const modeDetail = state.effective ? 'dry-run executor' : 'live executor via sandbox';
    return [
        renderProductBanner('Dry Mode', 'executor safety control'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Effective', value: effective, tone: 'accent' },
                { label: 'Behavior', value: modeDetail },
                { label: 'Persisted Default', value: persisted },
                { label: 'Session Override', value: sessionOverride },
                { label: 'Config', value: state.runtimeFlagsPath },
            ]),
        ], 'runtime toggle'),
    ].join('\n');
}
export { renderProgressLabel };

/**
 * Renders a compact, premium header for the Babel REPL.
 */
export function renderOperatorHeader(state) {
    const userStatus = state.lastRunUserStatus ?? 'ready';
    const statusBadge = renderBadge(userStatus.toUpperCase());
    const project = state.project ? accentBright(state.project) : muted('auto-detect');
    const model = state.model ? accentBlue(state.model) : muted('route-selected');

    return [
        '',
        `${accentBright('BABEL')} ${muted('·')} ${statusBadge} ${muted('·')} ${project} ${muted('·')} ${model}`,
        dim('─'.repeat(getTerminalWidth())),
        '',
    ].join('\n');
}
