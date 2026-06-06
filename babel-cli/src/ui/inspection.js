import { renderProductBanner } from './renderers.js';
import { renderSection } from './sections.js';
import { renderStatusRows } from './statusLine.js';
import { renderCheckRows, renderLabeledRows, renderOrderedList } from './tables.js';
import { renderStageTimeline } from './timeline.js';
import { muted, primary, wrapText } from './theme.js';
function renderTextParagraph(text, width = 84) {
    return wrapText(text, width).map(line => `  ${primary(line)}`).join('\n');
}
export function renderInspectRun(view) {
    return [
        renderProductBanner('Inspect Run', 'operator run overview'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Run', value: view.identity.name ?? view.runDir },
                { label: 'Project', value: view.project },
                { label: 'Mode', value: view.mode, tone: 'accent' },
                { label: 'Status', value: view.finalStatus, tone: 'accent' },
                { label: 'Task', value: view.task },
                ...(view.startedAt ? [{ label: 'Started', value: view.startedAt }] : []),
                { label: 'Artifacts', value: String(view.artifactCount) },
                { label: 'Checkpoints', value: String(view.checkpointCount ?? 0), tone: (view.checkpointCount ?? 0) > 0 ? 'accent' : undefined },
                { label: 'Restore', value: view.checkpointRestoreHint ?? 'Unavailable' },
                { label: 'Model Context', value: view.modelContextAvailable ? 'available' : 'Unavailable', tone: view.modelContextAvailable ? 'accent' : undefined },
                { label: 'Resume', value: view.modelContextRestoreHint ?? 'Unavailable' },
            ], { overflow: 'wrap' }),
        ], 'read-only view'),
        '',
        renderSection('PIPELINE', [
            renderStageTimeline(view.stageDescriptors, { overflow: 'wrap' }),
        ], 'stage progression'),
        '',
        renderSection('RELATED', [
            renderLabeledRows(view.artifactPointers, { overflow: 'wrap' }),
        ], 'inspection entry points'),
    ].join('\n');
}
export function renderInspectSummary(view) {
    const blocks = [
        renderProductBanner('Inspect Summary', 'existing summary artifact'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Run', value: view.identity.name ?? view.runDir },
                { label: 'Artifact', value: view.summaryArtifact?.filename ?? 'Unavailable', tone: view.summaryArtifact ? undefined : 'accent' },
            ], { overflow: 'wrap' }),
        ], 'read-only view'),
        '',
    ];
    if (!view.summaryArtifact) {
        blocks.push(renderSection('SUMMARY', [
            '  No summary artifact is present for this run.',
            '  Babel will not fabricate one from other evidence files in this command.',
        ], 'unavailable'));
        return blocks.join('\n');
    }
    if (view.summaryArtifact.format === 'json' && view.summaryArtifact.data && typeof view.summaryArtifact.data === 'object') {
        const data = view.summaryArtifact.data;
        const stageOutcomes = Array.isArray(data.stages)
            ? data.stages.map((stage) => typeof stage === 'string'
                ? stage
                : `${stage.stage ?? 'Stage'}: ${stage.outcome ?? stage.status ?? 'unknown'}`)
            : [];
        blocks.push(renderSection('SUMMARY', [
            renderStatusRows([
                ...(data.task || data.request ? [{ label: 'Task', value: data.task ?? data.request }] : []),
                ...(data.routing_summary ? [{ label: 'Routing', value: data.routing_summary }] : []),
                ...(data.final_outcome || data.result ? [{ label: 'Result', value: data.final_outcome ?? data.result, tone: 'accent' }] : []),
            ], { overflow: 'wrap' }),
            ...(stageOutcomes.length > 0 ? ['', renderOrderedList(stageOutcomes, { overflow: 'wrap' })] : []),
            ...(Array.isArray(data.warnings) && data.warnings.length > 0 ? ['', renderSection('WARNINGS', [renderOrderedList(data.warnings, { overflow: 'wrap' })], 'from summary artifact')] : []),
            ...(Array.isArray(data.holds) && data.holds.length > 0 ? ['', renderSection('HOLDS', [renderOrderedList(data.holds, { overflow: 'wrap' })], 'from summary artifact')] : []),
            ...(Array.isArray(data.unresolved_items) && data.unresolved_items.length > 0 ? ['', renderSection('UNRESOLVED', [renderOrderedList(data.unresolved_items, { overflow: 'wrap' })], 'from summary artifact')] : []),
        ], view.summaryArtifact.filename));
        return blocks.join('\n');
    }
    blocks.push(renderSection('SUMMARY', [
        renderTextParagraph(typeof view.summaryArtifact.data === 'string'
            ? view.summaryArtifact.data
            : JSON.stringify(view.summaryArtifact.data, null, 2)),
    ], view.summaryArtifact.filename));
    return blocks.join('\n');
}
export function renderInspectStack(view) {
    const entryBlocks = view.entries.length > 0
        ? view.entries.map((entry) => [
            `${muted(String(entry.order).padStart(2, '0'))} ${primary(entry.id ?? entry.name)}`,
            renderLabeledRows([
                { label: 'Type', value: entry.type },
                { label: 'Path', value: entry.path },
            ], { overflow: 'wrap', indent: '     ' }),
        ].join('\n'))
        : ['  No resolved stack entries are available in this run manifest.'];
    return [
        renderProductBanner('Inspect Stack', 'resolved instruction stack'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Run', value: view.identity.name ?? view.runDir },
                { label: 'Project', value: view.project },
                { label: 'Mode', value: view.mode, tone: 'accent' },
                ...(view.domainId ? [{ label: 'Domain', value: view.domainId, tone: 'accent' }] : []),
                ...(view.modelAdapterId ? [{ label: 'Adapter', value: view.modelAdapterId }] : []),
                { label: 'Entries', value: String(view.entries.length) },
            ], { overflow: 'wrap' }),
        ], 'read-only view'),
        '',
        renderSection('STACK', entryBlocks, 'resolved order'),
    ].join('\n');
}
export function renderInspectManifest(view) {
    const rows = view.artifactRecords.map((artifact) => ({
        status: artifact.present ? 'PASS' : 'PENDING',
        label: artifact.label,
        detail: artifact.present
            ? `${artifact.type} · ${artifact.path}${artifact.size !== null && artifact.size !== undefined ? ` · ${artifact.size} bytes` : ''}`
            : `missing · ${artifact.path}`,
    }));
    return [
        renderProductBanner('Inspect Manifest', 'artifact inventory'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Run', value: view.identity.name ?? view.runDir },
                { label: 'Status', value: view.finalStatus, tone: 'accent' },
                { label: 'Artifacts', value: String(view.artifactRecords.length) },
            ], { overflow: 'wrap' }),
        ], 'read-only view'),
        '',
        renderSection('ARTIFACTS', [
            renderCheckRows(rows, { overflow: 'wrap' }),
        ], 'evidence bundle inventory'),
    ].join('\n');
}
export function renderInspectOutcome(view) {
    const outcome = view.runOutcome;
    const warnings = Array.isArray(outcome.warnings) ? outcome.warnings : [];
    const detailRows = [
        { label: 'QA Verdict', value: outcome.qa_verdict ?? 'Unavailable', tone: outcome.qa_verdict === 'REJECT' ? 'accent' : undefined },
        { label: 'Execution', value: outcome.execution_status ?? (outcome.execution_performed ? 'performed' : 'not_performed') },
        { label: 'Purpose', value: outcome.purpose_mode ?? 'Unavailable' },
        { label: 'Purpose Resolution', value: outcome.purpose_resolution_mode ?? 'Unavailable' },
        { label: 'Purpose Seed', value: outcome.purpose_seed_skill_id ?? 'None' },
        { label: 'Suppression', value: outcome.purpose_suppression_reason ?? 'Unavailable' },
        { label: 'Domain', value: outcome.domain ?? 'Unavailable', tone: 'accent' },
        { label: 'Human Review', value: outcome.needs_human_review ? 'true' : 'false' },
        { label: 'Retry Allowed', value: outcome.retry_allowed ? 'true' : 'false' },
        ...(typeof outcome.schema_failure_count === 'number' ? [{ label: 'Schema Failure Entries', value: String(outcome.schema_failure_count), tone: outcome.schema_failure_count > 0 ? 'accent' : undefined }] : []),
        ...(typeof outcome.schema_failure_recovered_count === 'number' ? [{ label: 'Schema Recovery Count', value: String(outcome.schema_failure_recovered_count) }] : []),
        ...(typeof outcome.schema_shadow_hint_count === 'number' ? [{ label: 'Schema Hints', value: String(outcome.schema_shadow_hint_count) }] : []),
        ...(typeof outcome.schema_side_artifact_count === 'number' ? [{ label: 'Schema Side Artifacts', value: String(outcome.schema_side_artifact_count) }] : []),
        ...(outcome.schema_failure_last_stage ? [{ label: 'Last Schema Stage', value: outcome.schema_failure_last_stage }] : []),
        ...(outcome.schema_failure_last_kind ? [{ label: 'Last Schema Kind', value: outcome.schema_failure_last_kind }] : []),
        ...(outcome.failure_reason ? [{ label: 'Failure', value: outcome.failure_reason, tone: 'accent' }] : []),
        ...(outcome.hold_reason ? [{ label: 'Hold', value: outcome.hold_reason, tone: 'accent' }] : []),
    ];
    const changeRows = [];
    if (Array.isArray(outcome.files_changed) && outcome.files_changed.length > 0) {
        changeRows.push(renderSection('FILES CHANGED', [
            renderOrderedList(outcome.files_changed, { overflow: 'wrap' }),
        ], 'derived from execution report'));
    }
    if (Array.isArray(outcome.tests_run) && outcome.tests_run.length > 0) {
        changeRows.push(renderSection('TESTS RUN', [
            renderOrderedList(outcome.tests_run, { overflow: 'wrap' }),
        ], 'derived from execution report'));
    }
    if (warnings.length > 0) {
        changeRows.push(renderSection('WARNINGS', [
            renderOrderedList(warnings, { overflow: 'wrap' }),
        ], 'derived consistency checks'));
    }
    return [
        renderProductBanner('Inspect Outcome', 'derived operator-facing run outcome'),
        renderSection('STATUS', [
            renderStatusRows([
                { label: 'Run', value: view.identity.name ?? view.runDir },
                { label: 'Project', value: view.project },
                { label: 'Mode', value: view.mode, tone: 'accent' },
                { label: 'Outcome', value: outcome.status, tone: 'accent' },
                { label: 'Terminal', value: outcome.terminal ? 'true' : 'false' },
                { label: 'Source', value: outcome.status_source },
            ], { overflow: 'wrap' }),
        ], 'derived from existing artifacts'),
        '',
        renderSection('OUTCOME', [
            renderLabeledRows(detailRows, { overflow: 'wrap' }),
        ], 'canonical operator view'),
        ...(changeRows.length > 0 ? ['', ...changeRows] : []),
    ].join('\n');
}
