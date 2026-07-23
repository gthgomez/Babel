import { renderProductBanner } from './renderers.js';
import { renderSection } from './sections.js';
import { renderStatusRows, type StatusRow } from './statusLine.js';
import { renderCheckRows, renderLabeledRows, renderOrderedList } from './tables.js';
import { renderStageTimeline, type StageDescriptor } from './timeline.js';
import { muted, primary, wrapText } from './theme.js';

// ── View types ──────────────────────────────────────────────────────

export interface InspectIdentity {
  name?: string;
}

export interface InspectRunView {
  identity: InspectIdentity;
  runDir?: string;
  project?: string;
  mode?: string;
  finalStatus?: string;
  task?: string;
  startedAt?: string;
  artifactCount?: number;
  checkpointCount?: number;
  checkpointRestoreHint?: string;
  modelContextAvailable?: boolean;
  modelContextRestoreHint?: string;
  stageDescriptors: Array<{ index: number; label: string; state: string; meta?: unknown }>;
  artifactPointers: Array<{ label: string; value: string | number }>;
}

export interface InspectSummaryArtifact {
  filename?: string;
  format?: string;
  data?: unknown;
}

export interface InspectSummaryView {
  identity: InspectIdentity;
  runDir?: string;
  summaryArtifact?: InspectSummaryArtifact | null;
}

export interface InspectStackEntry {
  order: number;
  id?: string;
  name?: string;
  type: string;
  path: string;
}

export interface InspectStackView {
  identity: InspectIdentity;
  runDir?: string;
  project?: string;
  mode?: string;
  domainId?: string;
  modelAdapterId?: string;
  entries: InspectStackEntry[];
}

export interface InspectArtifactRecord {
  present: boolean;
  label: string;
  type: string;
  path: string;
  size?: number | null;
}

export interface InspectManifestView {
  identity: InspectIdentity;
  runDir?: string;
  finalStatus?: string;
  artifactRecords: InspectArtifactRecord[];
}

export interface InspectOutcomeData {
  qa_verdict?: string;
  execution_status?: string;
  execution_performed?: boolean;
  purpose_mode?: string;
  purpose_resolution_mode?: string;
  purpose_seed_skill_id?: string;
  purpose_suppression_reason?: string;
  domain?: string;
  needs_human_review?: boolean;
  retry_allowed?: boolean;
  schema_failure_count?: number;
  schema_failure_recovered_count?: number;
  schema_shadow_hint_count?: number;
  schema_side_artifact_count?: number;
  schema_failure_last_stage?: string;
  schema_failure_last_kind?: string;
  failure_reason?: string | null;
  hold_reason?: string | null;
  status: string;
  terminal: boolean;
  status_source: string;
  files_changed?: string[];
  tests_run?: string[];
  warnings?: string[];
}

export interface InspectOutcomeView {
  identity: InspectIdentity;
  runDir?: string;
  project?: string;
  mode?: string;
  runOutcome: InspectOutcomeData;
  finalStatus?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function renderTextParagraph(text: string, width = 84): string {
  return wrapText(text, width)
    .map((line: string) => `  ${primary(line)}`)
    .join('\n');
}

// ── Renderers ──────────────────────────────────────────────────────

export function renderInspectRun(view: InspectRunView): string {
  const statusRows: StatusRow[] = [
    { label: 'Run', value: view.identity.name ?? view.runDir ?? '?' },
    { label: 'Project', value: view.project ?? '?' },
    { label: 'Mode', value: view.mode ?? '?', tone: 'accent' },
    { label: 'Status', value: view.finalStatus ?? '?', tone: 'accent' },
    { label: 'Task', value: view.task ?? '?' },
    ...(view.startedAt ? [{ label: 'Started' as const, value: view.startedAt }] : []),
    { label: 'Artifacts', value: String(view.artifactCount ?? 0) },
    {
      label: 'Checkpoints',
      value: String(view.checkpointCount ?? 0),
      tone: (view.checkpointCount ?? 0) > 0 ? ('accent' as const) : undefined,
    },
    { label: 'Restore', value: view.checkpointRestoreHint ?? 'Unavailable' },
    {
      label: 'Model Context',
      value: view.modelContextAvailable ? 'available' : 'Unavailable',
      tone: view.modelContextAvailable ? ('accent' as const) : undefined,
    },
    { label: 'Resume', value: view.modelContextRestoreHint ?? 'Unavailable' },
  ];

  return [
    renderProductBanner('Inspect Run', 'operator run overview'),
    renderSection('STATUS', [renderStatusRows(statusRows, { overflow: 'wrap' })], 'read-only view'),
    '',
    renderSection(
      'PIPELINE',
      [renderStageTimeline(view.stageDescriptors as StageDescriptor[], { overflow: 'wrap' })],
      'stage progression',
    ),
    '',
    renderSection(
      'RELATED',
      [renderLabeledRows(view.artifactPointers as any, { overflow: 'wrap' })],
      'inspection entry points',
    ),
  ].join('\n');
}

export function renderInspectSummary(view: InspectSummaryView): string {
  const blocks = [
    renderProductBanner('Inspect Summary', 'existing summary artifact'),
    renderSection(
      'STATUS',
      [
        renderStatusRows(
          [
            { label: 'Run', value: view.identity.name ?? view.runDir ?? '?' },
            {
              label: 'Artifact',
              value: view.summaryArtifact?.filename ?? 'Unavailable',
              tone: view.summaryArtifact ? undefined : ('accent' as const),
            },
          ],
          { overflow: 'wrap' },
        ),
      ],
      'read-only view',
    ),
    '',
  ];

  if (!view.summaryArtifact) {
    blocks.push(
      renderSection(
        'SUMMARY',
        [
          '  No summary artifact is present for this run.',
          '  Babel will not fabricate one from other evidence files in this command.',
        ],
        'unavailable',
      ),
    );
    return blocks.join('\n');
  }

  if (
    view.summaryArtifact.format === 'json' &&
    view.summaryArtifact.data &&
    typeof view.summaryArtifact.data === 'object'
  ) {
    const data = view.summaryArtifact.data as Record<string, unknown>;
    const stageOutcomes: string[] = Array.isArray(data['stages'])
      ? (data['stages'] as Array<unknown>).map((stage) =>
          typeof stage === 'string'
            ? stage
            : `${(stage as any).stage ?? 'Stage'}: ${(stage as any).outcome ?? (stage as any).status ?? 'unknown'}`,
        )
      : [];

    blocks.push(
      renderSection(
        'SUMMARY',
        [
          renderStatusRows(
            [
              ...(data['task'] || data['request']
                ? [{ label: 'Task' as const, value: String(data['task'] ?? data['request']) }]
                : []),
              ...(data['routing_summary']
                ? [{ label: 'Routing' as const, value: String(data['routing_summary']) }]
                : []),
              ...(data['final_outcome'] || data['result']
                ? [
                    {
                      label: 'Result' as const,
                      value: String(data['final_outcome'] ?? data['result']),
                      tone: 'accent' as const,
                    },
                  ]
                : []),
            ],
            { overflow: 'wrap' },
          ),
          ...(stageOutcomes.length > 0
            ? ['', renderOrderedList(stageOutcomes, { overflow: 'wrap' })]
            : []),
          ...(Array.isArray(data['warnings']) && (data['warnings'] as unknown[]).length > 0
            ? [
                '',
                renderSection(
                  'WARNINGS',
                  [renderOrderedList(data['warnings'] as string[], { overflow: 'wrap' })],
                  'from summary artifact',
                ),
              ]
            : []),
          ...(Array.isArray(data['holds']) && (data['holds'] as unknown[]).length > 0
            ? [
                '',
                renderSection(
                  'HOLDS',
                  [renderOrderedList(data['holds'] as string[], { overflow: 'wrap' })],
                  'from summary artifact',
                ),
              ]
            : []),
          ...(Array.isArray(data['unresolved_items']) &&
          (data['unresolved_items'] as unknown[]).length > 0
            ? [
                '',
                renderSection(
                  'UNRESOLVED',
                  [
                    renderOrderedList(data['unresolved_items'] as string[], {
                      overflow: 'wrap',
                    }),
                  ],
                  'from summary artifact',
                ),
              ]
            : []),
        ],
        view.summaryArtifact.filename,
      ),
    );
    return blocks.join('\n');
  }

  blocks.push(
    renderSection(
      'SUMMARY',
      [
        renderTextParagraph(
          typeof view.summaryArtifact.data === 'string'
            ? view.summaryArtifact.data
            : JSON.stringify(view.summaryArtifact.data, null, 2),
        ),
      ],
      view.summaryArtifact.filename,
    ),
  );
  return blocks.join('\n');
}

export function renderInspectStack(view: InspectStackView): string {
  const entryBlocks =
    view.entries.length > 0
      ? view.entries.map((entry) =>
          [
            `${muted(String(entry.order).padStart(2, '0'))} ${primary(entry.id ?? entry.name ?? '?')}`,
            renderLabeledRows(
              [
                { label: 'Type', value: entry.type },
                { label: 'Path', value: entry.path },
              ] as any,
              { overflow: 'wrap', indent: '     ' },
            ),
          ].join('\n'),
        )
      : ['  No resolved stack entries are available in this run manifest.'];

  return [
    renderProductBanner('Inspect Stack', 'resolved instruction stack'),
    renderSection(
      'STATUS',
      [
        renderStatusRows(
          [
            { label: 'Run', value: view.identity.name ?? view.runDir ?? '?' },
            { label: 'Project', value: view.project ?? '?' },
            { label: 'Mode', value: view.mode ?? '?', tone: 'accent' as const },
            ...(view.domainId
              ? [{ label: 'Domain' as const, value: view.domainId, tone: 'accent' as const }]
              : []),
            ...(view.modelAdapterId
              ? [{ label: 'Adapter' as const, value: view.modelAdapterId }]
              : []),
            { label: 'Entries', value: String(view.entries.length) },
          ],
          { overflow: 'wrap' },
        ),
      ],
      'read-only view',
    ),
    '',
    renderSection('STACK', entryBlocks, 'resolved order'),
  ].join('\n');
}

export function renderInspectManifest(view: InspectManifestView): string {
  const rows = view.artifactRecords.map((artifact) => ({
    status: artifact.present ? ('PASS' as const) : ('PENDING' as const),
    label: artifact.label,
    detail: artifact.present
      ? `${artifact.type} · ${artifact.path}${artifact.size !== null && artifact.size !== undefined ? ` · ${artifact.size} bytes` : ''}`
      : `missing · ${artifact.path}`,
  }));

  return [
    renderProductBanner('Inspect Manifest', 'artifact inventory'),
    renderSection(
      'STATUS',
      [
        renderStatusRows(
          [
            { label: 'Run', value: view.identity.name ?? view.runDir ?? '?' },
            { label: 'Status', value: view.finalStatus ?? '?', tone: 'accent' as const },
            { label: 'Artifacts', value: String(view.artifactRecords.length) },
          ],
          { overflow: 'wrap' },
        ),
      ],
      'read-only view',
    ),
    '',
    renderSection(
      'ARTIFACTS',
      [renderCheckRows(rows, { overflow: 'wrap' })],
      'evidence bundle inventory',
    ),
  ].join('\n');
}

export function renderInspectOutcome(view: InspectOutcomeView): string {
  const outcome = view.runOutcome;
  const warnings: string[] = Array.isArray(outcome.warnings) ? outcome.warnings : [];
  const detailRows: StatusRow[] = [
    {
      label: 'QA Verdict',
      value: outcome.qa_verdict ?? 'Unavailable',
      tone: outcome.qa_verdict === 'REJECT' ? ('accent' as const) : undefined,
    },
    {
      label: 'Execution',
      value:
        outcome.execution_status ?? (outcome.execution_performed ? 'performed' : 'not_performed'),
    },
    { label: 'Purpose', value: outcome.purpose_mode ?? 'Unavailable' },
    { label: 'Purpose Resolution', value: outcome.purpose_resolution_mode ?? 'Unavailable' },
    { label: 'Purpose Seed', value: outcome.purpose_seed_skill_id ?? 'None' },
    { label: 'Suppression', value: outcome.purpose_suppression_reason ?? 'Unavailable' },
    { label: 'Domain', value: outcome.domain ?? 'Unavailable', tone: 'accent' as const },
    { label: 'Human Review', value: outcome.needs_human_review ? 'true' : 'false' },
    { label: 'Retry Allowed', value: outcome.retry_allowed ? 'true' : 'false' },
    ...(typeof outcome.schema_failure_count === 'number'
      ? [
          {
            label: 'Schema Failure Entries' as const,
            value: String(outcome.schema_failure_count),
            tone: outcome.schema_failure_count > 0 ? ('accent' as const) : undefined,
          },
        ]
      : []),
    ...(typeof outcome.schema_failure_recovered_count === 'number'
      ? [
          {
            label: 'Schema Recovery Count' as const,
            value: String(outcome.schema_failure_recovered_count),
          },
        ]
      : []),
    ...(typeof outcome.schema_shadow_hint_count === 'number'
      ? [{ label: 'Schema Hints' as const, value: String(outcome.schema_shadow_hint_count) }]
      : []),
    ...(typeof outcome.schema_side_artifact_count === 'number'
      ? [
          {
            label: 'Schema Side Artifacts' as const,
            value: String(outcome.schema_side_artifact_count),
          },
        ]
      : []),
    ...(outcome.schema_failure_last_stage
      ? [{ label: 'Last Schema Stage' as const, value: outcome.schema_failure_last_stage }]
      : []),
    ...(outcome.schema_failure_last_kind
      ? [{ label: 'Last Schema Kind' as const, value: outcome.schema_failure_last_kind }]
      : []),
    ...(outcome.failure_reason
      ? [
          {
            label: 'Failure' as const,
            value: outcome.failure_reason,
            tone: 'accent' as const,
          },
        ]
      : []),
    ...(outcome.hold_reason
      ? [
          {
            label: 'Hold' as const,
            value: outcome.hold_reason,
            tone: 'accent' as const,
          },
        ]
      : []),
  ];

  const changeRows: string[] = [];
  if (Array.isArray(outcome.files_changed) && outcome.files_changed.length > 0) {
    changeRows.push(
      renderSection(
        'FILES CHANGED',
        [renderOrderedList(outcome.files_changed, { overflow: 'wrap' })],
        'derived from execution report',
      ),
    );
  }
  if (Array.isArray(outcome.tests_run) && outcome.tests_run.length > 0) {
    changeRows.push(
      renderSection(
        'TESTS RUN',
        [renderOrderedList(outcome.tests_run, { overflow: 'wrap' })],
        'derived from execution report',
      ),
    );
  }
  if (warnings.length > 0) {
    changeRows.push(
      renderSection(
        'WARNINGS',
        [renderOrderedList(warnings, { overflow: 'wrap' })],
        'derived consistency checks',
      ),
    );
  }

  return [
    renderProductBanner('Inspect Outcome', 'derived operator-facing run outcome'),
    renderSection(
      'STATUS',
      [
        renderStatusRows(
          [
            { label: 'Run', value: view.identity.name ?? view.runDir ?? '?' },
            { label: 'Project', value: view.project ?? '?' },
            { label: 'Mode', value: view.mode ?? '?', tone: 'accent' as const },
            { label: 'Outcome', value: outcome.status, tone: 'accent' as const },
            { label: 'Terminal', value: outcome.terminal ? 'true' : 'false' },
            { label: 'Source', value: outcome.status_source },
          ],
          { overflow: 'wrap' },
        ),
      ],
      'derived from existing artifacts',
    ),
    '',
    renderSection(
      'OUTCOME',
      [renderLabeledRows(detailRows, { overflow: 'wrap' })],
      'canonical operator view',
    ),
    ...(changeRows.length > 0 ? ['', ...changeRows] : []),
  ].join('\n');
}
