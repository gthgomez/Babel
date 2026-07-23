import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
const SUMMARY_CANDIDATES = [
  '09_summary.json',
  '09_summary.md',
  '09_summary.txt',
  'summary.json',
  'summary.md',
  'summary.txt',
];
const STANDARD_ARTIFACTS = [
  {
    key: 'manifest',
    label: 'Manifest',
    filename: '01_manifest.json',
    type: 'json',
    optional: false,
  },
  {
    key: 'manual_prompt',
    label: 'Manual SWE Prompt',
    filename: '02_manual_swe_prompt.md',
    type: 'markdown',
    optional: true,
  },
  {
    key: 'manual_repair',
    label: 'Manual Plan Repair',
    filename: '02_manual_plan_repair.md',
    type: 'markdown',
    optional: true,
  },
  {
    key: 'execution_report',
    label: 'Execution Report',
    filename: '04_execution_report.json',
    type: 'json',
    optional: true,
  },
  {
    key: 'checkpoints',
    label: 'Checkpoints',
    filename: 'checkpoints/checkpoints.json',
    type: 'json',
    optional: true,
  },
  {
    key: 'waterfall',
    label: 'Waterfall Telemetry',
    filename: '05_waterfall_telemetry.json',
    type: 'json',
    optional: true,
  },
  {
    key: 'runtime_telemetry',
    label: 'Runtime Telemetry',
    filename: '06_runtime_telemetry.json',
    type: 'json',
    optional: true,
  },
  {
    key: 'trace_context',
    label: 'Trace Context',
    filename: '07_trace_context.json',
    type: 'json',
    optional: true,
  },
  {
    key: 'routing_decision',
    label: 'Routing Decision',
    filename: '08_routing_decision.json',
    type: 'json',
    optional: true,
  },
  {
    key: 'session_context',
    label: 'Session Context',
    filename: '10_session_context.json',
    type: 'json',
    optional: true,
  },
];
const SCHEMA_FAILURE_LEDGER_FILENAME = '08_schema_failures.jsonl';
const SCHEMA_LEARNING_DIR = '_schema_learning';
const SCHEMA_SHADOW_HINTS_FILENAME = 'schema_shadow_hints.json';
const SCHEMA_FAILURE_ARTIFACT_DIR = 'schema_failures';

function readJsonlRecords(path) {
  if (!existsSync(path)) {
    return [];
  }
  const raw = safeReadText(path);
  if (!raw) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null && typeof entry === 'object');
}

function countSchemaFailureArtifacts(runDir) {
  const path = join(runDir, SCHEMA_FAILURE_ARTIFACT_DIR);
  if (!existsSync(path)) {
    return 0;
  }
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

function readSchemaShadowHints(runDir) {
  const path = join(dirname(runDir), SCHEMA_LEARNING_DIR, SCHEMA_SHADOW_HINTS_FILENAME);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = safeReadJson(path);
  return Array.isArray(parsed?.hints)
    ? parsed.hints.filter((hint) => hint && typeof hint === 'object')
    : [];
}

function buildSchemaLearningSummary(runDir) {
  const ledgerPath = join(runDir, SCHEMA_FAILURE_LEDGER_FILENAME);
  const shadowHintsPath = join(dirname(runDir), SCHEMA_LEARNING_DIR, SCHEMA_SHADOW_HINTS_FILENAME);
  const schemaFailureArtifactsPath = join(runDir, SCHEMA_FAILURE_ARTIFACT_DIR);
  const ledgerEntries = readJsonlRecords(ledgerPath);
  const recoveryOutcomes = {
    recovered: 0,
    fatal: 0,
    cascaded: 0,
    pendingRetry: 0,
    unknown: 0,
  };
  for (const entry of ledgerEntries) {
    if (entry.retry_outcome === 'recovered') {
      recoveryOutcomes.recovered += 1;
    } else if (entry.retry_outcome === 'fatal') {
      recoveryOutcomes.fatal += 1;
    } else if (entry.retry_outcome === 'cascaded') {
      recoveryOutcomes.cascaded += 1;
    } else if (entry.retry_outcome === 'pending_retry') {
      recoveryOutcomes.pendingRetry += 1;
    } else {
      recoveryOutcomes.unknown += 1;
    }
  }
  const hints = readSchemaShadowHints(runDir);
  const hintRows = Array.isArray(hints)
    ? hints
        .slice()
        .sort((left, right) => (right.count ?? 0) - (left.count ?? 0))
        .slice(0, 3)
        .map(
          (hint) =>
            `${hint.schema_name ?? 'unknown'}:${hint.stage ?? 'unknown'} ` +
            `${hint.hint ?? 'No hint text available'} (${String(hint.count ?? 0)})`,
        )
    : [];
  return {
    ledgerPath,
    ledgerEntryCount: ledgerEntries.length,
    recoveryOutcomes,
    schemaFailureArtifactsPath,
    schemaFailureArtifactCount: countSchemaFailureArtifacts(runDir),
    shadowHintsPath,
    shadowHintCount: Array.isArray(hints) ? hints.length : 0,
    shadowHints: hintRows,
    latestFailureKind:
      ledgerEntries.length > 0 &&
      typeof ledgerEntries[ledgerEntries.length - 1].failure_kind === 'string'
        ? ledgerEntries[ledgerEntries.length - 1].failure_kind
        : 'unknown',
    latestFailureStage:
      ledgerEntries.length > 0 && typeof ledgerEntries[ledgerEntries.length - 1].stage === 'string'
        ? ledgerEntries[ledgerEntries.length - 1].stage
        : 'unknown',
  };
}
function readLatestRunPointer(project, babelRunsDir) {
  const scoped = project ? join(babelRunsDir, `.latest.${project}.json`) : null;
  const fallback = join(babelRunsDir, '.latest.json');
  const candidates = scoped ? [scoped, fallback] : [fallback];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (
        typeof parsed.run_dir === 'string' &&
        parsed.run_dir.length > 0 &&
        existsSync(parsed.run_dir)
      ) {
        return parsed.run_dir;
      }
    } catch {
      continue;
    }
  }
  return null;
}
function resolveRunDirBySessionId(sessionId, babelRunsDir) {
  const normalizedSessionId = sessionId?.trim();
  if (!normalizedSessionId) {
    throw new Error('session-id must be non-empty.');
  }
  if (!existsSync(babelRunsDir)) {
    throw new Error(`No Babel runs directory found at ${babelRunsDir}.`);
  }
  const candidates = readdirSync(babelRunsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'local-learning' &&
        /^\d{8}_\d{6}_.+/.test(entry.name),
    )
    .map((entry) => join(babelRunsDir, entry.name))
    .sort((left, right) => {
      const leftStats = statSync(left);
      const rightStats = statSync(right);
      return rightStats.mtimeMs - leftStats.mtimeMs;
    });
  for (const candidate of candidates) {
    const manifestPath = join(candidate, '01_manifest.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = safeReadJson(manifestPath);
    if (
      manifest &&
      typeof manifest.session_id === 'string' &&
      manifest.session_id === normalizedSessionId
    ) {
      return candidate;
    }
  }
  throw new Error(`No Babel run directory matched session_id "${normalizedSessionId}".`);
}
export function resolveInspectRunDir(options) {
  const sessionId = options.sessionId?.trim();
  if (sessionId) {
    return resolveRunDirBySessionId(sessionId, options.babelRunsDir);
  }
  const runInput = options.run?.trim();
  if (runInput) {
    const sessionPrefixMatch = runInput.match(/^session(?:-id)?:(.+)$/i);
    if (sessionPrefixMatch) {
      return resolveRunDirBySessionId(sessionPrefixMatch[1], options.babelRunsDir);
    }
  }
  if (!runInput || runInput.toLowerCase() === 'latest') {
    const latest = readLatestRunPointer(options.project, options.babelRunsDir);
    if (!latest) {
      throw new Error(
        `No latest run pointer found${options.project ? ` for project ${options.project}` : ''}.`,
      );
    }
    return latest;
  }
  return runInput;
}
function safeReadJson(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
function safeReadText(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
function parseRunIdentity(runDir) {
  const name = basename(runDir);
  const match = name.match(/^(\d{8})_(\d{6})_(.+)$/);
  if (!match) {
    return { name };
  }
  const [, ymd, hms, slug] = match;
  const timestamp = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
  return {
    name,
    slug,
    started_at: timestamp,
  };
}
function listRunFiles(runDir) {
  if (!existsSync(runDir)) {
    return [];
  }
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(runDir, entry.name);
      const stats = statSync(path);
      return {
        name: entry.name,
        path,
        size: stats.size,
        modified_at: stats.mtime.toISOString(),
        extension: extname(entry.name).toLowerCase(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
function loadSummaryArtifact(runDir) {
  for (const filename of SUMMARY_CANDIDATES) {
    const path = join(runDir, filename);
    if (!existsSync(path)) {
      continue;
    }
    if (filename.endsWith('.json')) {
      return {
        filename,
        path,
        format: 'json',
        data: safeReadJson(path),
      };
    }
    return {
      filename,
      path,
      format: 'text',
      data: safeReadText(path),
    };
  }
  return null;
}
function loadNumberedArtifacts(runDir, prefix) {
  return listRunFiles(runDir)
    .filter((file) => file.name.startsWith(prefix))
    .map((file) => ({
      ...file,
      data: file.extension === '.json' ? safeReadJson(file.path) : safeReadText(file.path),
    }));
}
function inferLayerTypeFromPath(path) {
  if (!path) return 'unknown';
  if (path.includes('\\01_Behavioral_OS\\') || path.includes('/01_Behavioral_OS/'))
    return 'behavioral_os';
  if (path.includes('\\02_Domain_Architects\\') || path.includes('/02_Domain_Architects/'))
    return 'domain_architect';
  if (path.includes('\\02_Skills\\') || path.includes('/02_Skills/')) return 'skill';
  if (path.includes('\\07_Pipeline_Stages\\') || path.includes('/07_Pipeline_Stages/'))
    return 'pipeline_stage';
  if (path.includes('\\03_Model_Adapters\\') || path.includes('/03_Model_Adapters/'))
    return 'model_adapter';
  if (path.includes('\\05_Project_Overlays\\') || path.includes('/05_Project_Overlays/'))
    return 'project_overlay';
  if (path.includes('\\06_Task_Overlays\\') || path.includes('/06_Task_Overlays/'))
    return 'task_overlay';
  return 'unknown';
}
function inferFinalStatus(bundle) {
  return (
    bundle.runtimeTelemetry?.final_outcome ??
    bundle.executionReport?.status ??
    bundle.manifest?.runtime_telemetry?.final_outcome ??
    null
  );
}
function inferLatestQaVerdict(bundle) {
  if (bundle.runtimeTelemetry?.qa_verdict) {
    return bundle.runtimeTelemetry.qa_verdict;
  }
  if (bundle.qaVerdicts.length > 0) {
    return bundle.qaVerdicts[bundle.qaVerdicts.length - 1].data?.verdict ?? null;
  }
  return bundle.manifest?.runtime_telemetry?.qa_verdict ?? null;
}
function inferQaFailureTags(bundle) {
  if (
    Array.isArray(bundle.runtimeTelemetry?.qa_failure_tags) &&
    bundle.runtimeTelemetry.qa_failure_tags.length > 0
  ) {
    return [...bundle.runtimeTelemetry.qa_failure_tags];
  }
  const latestQa =
    bundle.qaVerdicts.length > 0 ? bundle.qaVerdicts[bundle.qaVerdicts.length - 1].data : null;
  if (latestQa?.verdict === 'REJECT' && Array.isArray(latestQa.failures)) {
    return latestQa.failures
      .map((failure) => failure?.tag)
      .filter((tag) => typeof tag === 'string' && tag.length > 0);
  }
  return Array.isArray(bundle.manifest?.runtime_telemetry?.qa_failure_tags)
    ? [...bundle.manifest.runtime_telemetry.qa_failure_tags]
    : [];
}
function deriveFilesChanged(executionReport) {
  if (!executionReport || !Array.isArray(executionReport.tool_call_log)) {
    return [];
  }
  return [
    ...new Set(
      executionReport.tool_call_log
        .filter(
          (entry) =>
            (entry?.tool === 'file_write' || entry?.tool === 'write_file') &&
            typeof entry?.target === 'string' &&
            entry.target.length > 0,
        )
        .map((entry) => entry.target),
    ),
  ];
}
function deriveTestsRun(executionReport) {
  if (!executionReport || !Array.isArray(executionReport.tool_call_log)) {
    return [];
  }
  return [
    ...new Set(
      executionReport.tool_call_log
        .filter(
          (entry) =>
            entry?.tool === 'test_run' &&
            typeof entry?.target === 'string' &&
            entry.target.length > 0,
        )
        .map((entry) => entry.target),
    ),
  ];
}
function deriveOutcomeStatus(bundle) {
  const executionStatus = bundle.executionReport?.status ?? null;
  const finalOutcome =
    bundle.runtimeTelemetry?.final_outcome ??
    bundle.manifest?.runtime_telemetry?.final_outcome ??
    null;
  const warnings = [];
  if (
    bundle.manifest?.runtime_telemetry?.final_outcome != null &&
    bundle.runtimeTelemetry?.final_outcome != null &&
    bundle.manifest.runtime_telemetry.final_outcome !== bundle.runtimeTelemetry.final_outcome
  ) {
    warnings.push(
      `Manifest runtime_telemetry.final_outcome (${bundle.manifest.runtime_telemetry.final_outcome}) differs from 06_runtime_telemetry.json (${bundle.runtimeTelemetry.final_outcome}).`,
    );
  }
  if (
    (executionStatus === 'EXECUTION_HALTED' || executionStatus === 'ACTIVATION_REFUSED') &&
    finalOutcome === 'COMPLETE'
  ) {
    warnings.push(
      `Execution report status (${executionStatus}) conflicts with runtime final outcome (${finalOutcome}). Outcome is derived conservatively from execution_report.`,
    );
  }
  if (executionStatus === 'EXECUTION_COMPLETE') {
    return {
      status: 'completed',
      terminal: true,
      statusSource: 'execution_report',
      failureReason: null,
      holdReason: null,
      retryAllowed: false,
      warnings,
    };
  }
  if (executionStatus === 'EXECUTION_HALTED') {
    return {
      status: 'halted',
      terminal: true,
      statusSource: 'execution_report',
      failureReason: bundle.executionReport?.pipeline_error?.condition ?? 'Execution halted.',
      holdReason: null,
      retryAllowed: false,
      warnings,
    };
  }
  if (executionStatus === 'ACTIVATION_REFUSED') {
    return {
      status: 'halted',
      terminal: true,
      statusSource: 'execution_report',
      failureReason: bundle.executionReport?.reason ?? 'Activation refused.',
      holdReason: 'activation_refused',
      retryAllowed: false,
      warnings,
    };
  }
  switch (finalOutcome) {
    case 'COMPLETE':
      return {
        status: 'completed',
        terminal: true,
        statusSource: 'runtime_telemetry',
        failureReason: null,
        holdReason: null,
        retryAllowed: false,
        warnings,
      };
    case 'MANUAL_BRIDGE_REQUIRED':
      return {
        status: 'manual_bridge_required',
        terminal: true,
        statusSource: 'runtime_telemetry',
        failureReason: null,
        holdReason: 'manual_bridge_required',
        retryAllowed: false,
        warnings,
      };
    case 'QA_REJECTED_MAX_LOOPS':
    case 'INCOMPLETE_DELIVERABLE':
      return {
        status: 'rejected',
        terminal: true,
        statusSource: 'runtime_telemetry',
        failureReason: finalOutcome,
        holdReason: null,
        retryAllowed: false,
        warnings,
      };
    default:
      break;
  }
  if (typeof finalOutcome === 'string' && /timeout/i.test(finalOutcome)) {
    return {
      status: 'timeout',
      terminal: true,
      statusSource: 'runtime_telemetry',
      failureReason: finalOutcome,
      holdReason: null,
      retryAllowed: true,
      warnings,
    };
  }
  return {
    status: 'unknown',
    terminal: false,
    statusSource: finalOutcome ? 'runtime_telemetry' : 'derived',
    failureReason: finalOutcome,
    holdReason: null,
    retryAllowed: false,
    warnings,
  };
}
export function loadInspectBundle(runDir) {
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }
  const files = listRunFiles(runDir);
  const schemaLearningHintPath = join(
    dirname(runDir),
    SCHEMA_LEARNING_DIR,
    SCHEMA_SHADOW_HINTS_FILENAME,
  );
  const schemaFailurePath = join(runDir, SCHEMA_FAILURE_LEDGER_FILENAME);
  const artifactRecords = STANDARD_ARTIFACTS.map((artifact) => {
    const path = join(runDir, artifact.filename);
    const present = existsSync(path);
    return {
      ...artifact,
      path,
      present,
      size: present ? statSync(path).size : null,
    };
  });
  const summaryArtifact = loadSummaryArtifact(runDir);
  if (summaryArtifact) {
    artifactRecords.push({
      key: 'summary',
      label: 'Summary Artifact',
      filename: summaryArtifact.filename,
      path: summaryArtifact.path,
      present: true,
      type: summaryArtifact.format,
      optional: true,
      size: statSync(summaryArtifact.path).size,
    });
  }
  artifactRecords.push(
    {
      key: 'schema_failures',
      label: 'Schema Failures Ledger',
      filename: SCHEMA_FAILURE_LEDGER_FILENAME,
      path: schemaFailurePath,
      present: existsSync(schemaFailurePath),
      type: 'jsonl',
      optional: true,
      size: null,
    },
    {
      key: 'schema_learning',
      label: 'Schema Shadow Hints',
      filename: SCHEMA_SHADOW_HINTS_FILENAME,
      path: schemaLearningHintPath,
      present: existsSync(schemaLearningHintPath),
      type: 'json',
      optional: true,
      size: null,
    },
    {
      key: 'schema_learning_artifacts',
      label: 'Schema Failure Side-Effect Artifacts',
      filename: SCHEMA_FAILURE_ARTIFACT_DIR,
      path: join(runDir, SCHEMA_FAILURE_ARTIFACT_DIR),
      present: existsSync(join(runDir, SCHEMA_FAILURE_ARTIFACT_DIR)),
      type: 'directory',
      optional: true,
      size: null,
    },
  );
  return {
    runDir,
    identity: parseRunIdentity(runDir),
    files,
    artifactRecords,
    schemaLearning: buildSchemaLearningSummary(runDir),
    manifest: safeReadJson(join(runDir, '01_manifest.json')),
    runtimeTelemetry: safeReadJson(join(runDir, '06_runtime_telemetry.json')),
    traceContext: safeReadJson(join(runDir, '07_trace_context.json')),
    routingDecision: safeReadJson(join(runDir, '08_routing_decision.json')),
    waterfallTelemetry: safeReadJson(join(runDir, '05_waterfall_telemetry.json')),
    checkpoints: safeReadJson(join(runDir, 'checkpoints', 'checkpoints.json')),
    sessionContext: safeReadJson(join(runDir, '10_session_context.json')),
    executionReport: safeReadJson(join(runDir, '04_execution_report.json')),
    manualPrompt: safeReadText(join(runDir, '02_manual_swe_prompt.md')),
    manualRepair: safeReadText(join(runDir, '02_manual_plan_repair.md')),
    swePlans: loadNumberedArtifacts(runDir, '02_swe_plan_v'),
    qaVerdicts: loadNumberedArtifacts(runDir, '03_qa_verdict_v'),
    summaryArtifact,
  };
}
function buildStageDescriptorsForBundle(bundle) {
  const finalStatus = inferFinalStatus(bundle);
  const pipelineMode =
    bundle.runtimeTelemetry?.pipeline_mode ?? bundle.manifest?.analysis?.pipeline_mode ?? 'unknown';
  const latestQaVerdict =
    bundle.qaVerdicts.length > 0
      ? bundle.qaVerdicts[bundle.qaVerdicts.length - 1].data?.verdict
      : null;
  const executionStatus = bundle.executionReport?.status ?? null;
  const plannerAttempts = bundle.swePlans.length;
  const qaAttempts = bundle.qaVerdicts.length;
  return [
    {
      index: 1,
      label: 'Orchestrator',
      state: bundle.manifest ? 'PASS' : 'PENDING',
      meta: bundle.manifest?.orchestrator_version
        ? `v${String(bundle.manifest.orchestrator_version).replace('.0', '')}`
        : undefined,
    },
    {
      index: 2,
      label: 'Planner',
      state:
        plannerAttempts > 0 || bundle.manualPrompt
          ? 'PASS'
          : bundle.manifest
            ? 'PENDING'
            : 'PENDING',
      meta:
        plannerAttempts > 0
          ? `${plannerAttempts} plan artifact(s)`
          : bundle.manualPrompt
            ? 'manual prompt exported'
            : undefined,
    },
    {
      index: 3,
      label: 'QA Reviewer',
      state:
        latestQaVerdict === 'PASS'
          ? 'PASS'
          : finalStatus === 'QA_REJECTED_MAX_LOOPS'
            ? 'FAIL'
            : pipelineMode === 'plan' || pipelineMode === 'chat'
              ? 'BLOCKED'
              : qaAttempts > 0
                ? 'PENDING'
                : 'PENDING',
      meta:
        qaAttempts > 0
          ? `${qaAttempts} verdict artifact(s)`
          : pipelineMode === 'plan' || pipelineMode === 'chat'
            ? `mode ${pipelineMode}`
            : undefined,
    },
    {
      index: 4,
      label: 'Executor',
      state:
        executionStatus === 'EXECUTION_COMPLETE'
          ? 'PASS'
          : executionStatus === 'EXECUTION_HALTED'
            ? 'FAIL'
            : executionStatus === 'ACTIVATION_REFUSED'
              ? 'BLOCKED'
              : pipelineMode === 'deep'
                ? 'PENDING'
                : 'BLOCKED',
      meta: executionStatus ?? (pipelineMode === 'deep' ? undefined : `mode ${pipelineMode}`),
    },
  ];
}
export function buildInspectRunView(bundle) {
  const finalStatus = inferFinalStatus(bundle);
  const task =
    bundle.manifest?.analysis?.task_summary ??
    bundle.manifest?.handoff_payload?.user_request ??
    'Unavailable';
  return {
    kind: 'run',
    runDir: bundle.runDir,
    identity: bundle.identity,
    project: bundle.manifest?.target_project ?? 'unknown',
    mode:
      bundle.runtimeTelemetry?.pipeline_mode ??
      bundle.manifest?.analysis?.pipeline_mode ??
      'unknown',
    finalStatus: finalStatus ?? 'UNKNOWN',
    task,
    startedAt: bundle.identity.started_at ?? null,
    stageDescriptors: buildStageDescriptorsForBundle(bundle),
    artifactPointers: [
      { label: 'Summary', value: bundle.summaryArtifact?.path ?? 'Unavailable' },
      {
        label: 'Stack Source',
        value:
          bundle.artifactRecords.find((artifact) => artifact.key === 'manifest')?.path ??
          'Unavailable',
      },
      {
        label: 'Manifest',
        value:
          bundle.artifactRecords.find((artifact) => artifact.key === 'manifest')?.path ??
          'Unavailable',
      },
      {
        label: 'Checkpoints',
        value:
          bundle.artifactRecords.find((artifact) => artifact.key === 'checkpoints')?.path ??
          'Unavailable',
      },
      {
        label: 'Session Context',
        value:
          bundle.artifactRecords.find((artifact) => artifact.key === 'session_context')?.path ??
          'Unavailable',
      },
      { label: 'Schema Failure Ledger', value: bundle.schemaLearning.ledgerPath ?? 'Unavailable' },
      {
        label: 'Schema Learning Hints',
        value: bundle.schemaLearning.shadowHintsPath ?? 'Unavailable',
      },
      {
        label: 'Schema Failure Side Artifacts',
        value: `${bundle.schemaLearning.schemaFailureArtifactsPath} (${String(bundle.schemaLearning.schemaFailureArtifactCount)})`,
      },
    ],
    checkpointCount: Array.isArray(bundle.checkpoints?.checkpoints)
      ? bundle.checkpoints.checkpoints.length
      : 0,
    checkpointRestoreHint: 'babel checkpoint list --run "' + bundle.runDir + '"',
    modelContextAvailable: Boolean(bundle.sessionContext),
    modelContextRestoreHint: bundle.sessionContext
      ? 'babel session resume "' + bundle.runDir + '" --json'
      : 'Unavailable',
    artifactCount: bundle.files.length,
  };
}
export function buildInspectSummaryView(bundle) {
  return {
    kind: 'summary',
    runDir: bundle.runDir,
    identity: bundle.identity,
    summaryArtifact: bundle.summaryArtifact,
  };
}
export function buildInspectStackView(bundle) {
  const selectedIds = bundle.manifest?.compiled_artifacts?.selected_entry_ids ?? [];
  const promptManifest =
    bundle.manifest?.compiled_artifacts?.prompt_manifest ?? bundle.manifest?.prompt_manifest ?? [];
  const orderedEntries = promptManifest.map((path, index) => ({
    order: index + 1,
    id: selectedIds[index] ?? null,
    path,
    type: inferLayerTypeFromPath(path),
    name: basename(path),
  }));
  return {
    kind: 'stack',
    runDir: bundle.runDir,
    identity: bundle.identity,
    project: bundle.manifest?.target_project ?? 'unknown',
    mode:
      bundle.runtimeTelemetry?.pipeline_mode ??
      bundle.manifest?.analysis?.pipeline_mode ??
      'unknown',
    domainId: bundle.manifest?.instruction_stack?.domain_id ?? null,
    modelAdapterId: bundle.manifest?.instruction_stack?.model_adapter_id ?? null,
    entries: orderedEntries,
  };
}
export function buildInspectManifestView(bundle) {
  return {
    kind: 'manifest',
    runDir: bundle.runDir,
    identity: bundle.identity,
    finalStatus: inferFinalStatus(bundle) ?? 'UNKNOWN',
    artifactRecords: [
      ...bundle.artifactRecords,
      ...bundle.files
        .filter(
          (file) => !bundle.artifactRecords.some((artifact) => artifact.filename === file.name),
        )
        .map((file) => ({
          key: file.name,
          label: file.name,
          filename: file.name,
          path: file.path,
          present: true,
          type: file.extension.replace(/^\./, '') || 'file',
          optional: true,
          size: file.size,
        })),
    ],
  };
}
export function buildInspectOutcomeView(bundle) {
  const mode =
    bundle.runtimeTelemetry?.pipeline_mode ?? bundle.manifest?.analysis?.pipeline_mode ?? 'unknown';
  const qaVerdict = inferLatestQaVerdict(bundle);
  const outcomeStatus = deriveOutcomeStatus(bundle);
  const executionStatus = bundle.executionReport?.status ?? null;
  const executionPerformed = Boolean(
    bundle.executionReport &&
    ((typeof bundle.executionReport.steps_executed === 'number' &&
      bundle.executionReport.steps_executed > 0) ||
      (Array.isArray(bundle.executionReport.tool_call_log) &&
        bundle.executionReport.tool_call_log.length > 0)),
  );
  const filesChanged = deriveFilesChanged(bundle.executionReport);
  const testsRun = deriveTestsRun(bundle.executionReport);
  return {
    kind: 'outcome',
    runDir: bundle.runDir,
    identity: bundle.identity,
    project: bundle.manifest?.target_project ?? 'unknown',
    mode,
    runOutcome: {
      status: outcomeStatus.status,
      terminal: outcomeStatus.terminal,
      status_source: outcomeStatus.statusSource,
      qa_verdict: qaVerdict,
      qa_failure_tags: inferQaFailureTags(bundle),
      execution_performed: executionPerformed,
      execution_status: executionStatus,
      purpose_mode: bundle.manifest?.analysis?.purpose_mode ?? null,
      purpose_resolution_mode: bundle.manifest?.compiled_artifacts?.purpose_resolution_mode ?? null,
      purpose_seed_skill_id: bundle.manifest?.compiled_artifacts?.purpose_seed_skill_id ?? null,
      purpose_suppression_reason:
        bundle.manifest?.compiled_artifacts?.purpose_suppression_reason ?? null,
      domain:
        bundle.runtimeTelemetry?.domain_id ?? bundle.manifest?.instruction_stack?.domain_id ?? null,
      files_changed: filesChanged,
      tests_run: testsRun,
      needs_human_review: outcomeStatus.status !== 'completed',
      retry_allowed: outcomeStatus.retryAllowed,
      schema_failure_count: bundle.schemaLearning.ledgerEntryCount,
      schema_failure_recovered_count: bundle.schemaLearning.recoveryOutcomes.recovered,
      schema_failure_last_stage: bundle.schemaLearning.latestFailureStage,
      schema_failure_last_kind: bundle.schemaLearning.latestFailureKind,
      schema_shadow_hint_count: bundle.schemaLearning.shadowHintCount,
      schema_side_artifact_count: bundle.schemaLearning.schemaFailureArtifactCount,
      failure_reason: outcomeStatus.failureReason,
      hold_reason: outcomeStatus.holdReason,
      warnings: outcomeStatus.warnings,
    },
  };
}
