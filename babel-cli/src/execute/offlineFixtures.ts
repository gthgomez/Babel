/** Deterministic model-boundary fixtures; never used as live-provider output. */
import type { RunOptions } from '../execute.js';

export const RELIABILITY_REPAIR_PROOF_MARKER =
  '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]';

/**
 * Offline fixture scenario selector.
 * Set BABEL_PIPELINE_V9_OFFLINE_SCENARIO to one of:
 *   - "happy_path" (default): orchestrator → SWE → QA PASS → executor COMPLETE
 *   - "qa_reject_once": QA rejects on first call, passes on second call
 *   - "qa_reject_max": QA always rejects (pipeline halts after MAX_SWE_QA_LOOPS)
 *   - "evidence_loop": SWE emits EVIDENCE_REQUEST, then replans after evidence
 */
function getOfflineScenario(): string {
  return (
    process.env['BABEL_PIPELINE_V9_OFFLINE_SCENARIO']?.trim() || 'happy_path'
  );
}

/** Module-level counter for tracking QA calls across the pipeline lifecycle. */
let qaCallCount = 0;
function incrementQaCallCount(): number {
  qaCallCount++;
  return qaCallCount;
}

/** Reset the QA call counter (for integration tests using offline fixture scenarios). */
export function resetOfflineQaCallCount(): void {
  qaCallCount = 0;
}

function detectPipelineV9OfflineLane(prompt: string): 'frontend' | 'backend' {
  return /regression frontend verified lane/i.test(prompt)
    ? 'frontend'
    : 'backend';
}

function buildOtelOfflineOrchestratorManifest(
  mode: 'deep',
  repoRoot: string,
): Record<string, unknown> {
  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    target_project_path: repoRoot,
    analysis: {
      task_summary: 'OTel regression deep lane.',
      task_category: 'Backend',
      secondary_category: null,
      complexity_estimate: 'Medium',
      pipeline_mode: 'deep',
      ambiguity_note: null,
      routing_confidence: 0.95,
    },
    platform_profile: {
      profile_source: 'not_required_for_routing',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'none',
      repo_write_mode: null,
      output_surface: [],
      platform_modes: [],
      execution_trust: null,
      data_trust: null,
      freshness_trust: null,
      action_trust: null,
      approval_mode: 'none',
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'OTel regression fixture selects qwen3.',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v11'],
      domain_id: 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'OTEL deep lane TELEMETRY_SECRET_TASK_MARKER',
      system_directive:
        'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  };
}

function buildPipelineV9OfflineOrchestratorManifest(
  prompt: string,
): Record<string, unknown> {
  const repoRoot = process.env['BABEL_PROJECT_ROOT']?.trim() || process.cwd();
  // The orchestrator prompt is a compiled document containing examples and
  // catalog text. Preserve only the caller's task in the fixture manifest so
  // offline compilation does not mistake instructional literals for task
  // bindings.
  const taskContext = prompt.lastIndexOf('--- TASK CONTEXT ---');
  const taskSection = taskContext >= 0 ? prompt.slice(taskContext) : prompt;
  const taskMatch =
    /Task:\s*([\s\S]*?)(?:\r?\nPreferred project:|\r?\nPreferred pipeline mode:|$)/i.exec(
      taskSection,
    );
  const userRequest = taskMatch?.[1]?.trim() || 'Offline pipeline fixture.';
  const base = buildOtelOfflineOrchestratorManifest('deep', repoRoot);
  return {
    ...base,
    analysis: {
      ...(base.analysis as Record<string, unknown>),
      task_summary: userRequest,
    },
    handoff_payload: {
      ...(base.handoff_payload as Record<string, unknown>),
      user_request: userRequest,
    },
  };
}

function buildOtelOfflineSwePlan(): Record<string, unknown> {
  return {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary:
      'OBJECTIVE: Exercise OTel tracing without leaking prompt contents.',
    known_facts: [
      'The orchestrator emitted a typed v9 manifest.',
      'The tracing test needs a valid QA PASS path.',
    ],
    assumptions: [
      'A single safe read-only step is sufficient for autonomous executor validation.',
    ],
    risks: [
      {
        risk: 'The executor completion could become schema-invalid without a verified step.',
        likelihood: 'low',
        mitigation: 'Emit one file_read step before EXECUTION_COMPLETE.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description:
          'Inspect the CLI package metadata for trace coverage.',
        tool: 'file_read',
        target: 'babel-cli/package.json',
        rationale: 'Provides one safe executor step before completion.',
        reversible: true,
        verification:
          'The CLI package metadata is readable and contains the package name.',
      },
    ],
    root_cause: 'N/A — tracing regression coverage',
    out_of_scope: ['Repository mutation', 'Shell execution'],
  };
}

function buildPipelineV9OfflineSwePlan(lane: 'frontend' | 'backend') {
  const label = lane === 'frontend' ? 'frontend' : 'backend';
  return {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: `OBJECTIVE: Validate the v9 compiled ${label} verified lane.`,
    known_facts: [
      'The orchestrator emitted a typed v9 manifest in uncompiled form.',
      'The compiler must populate prompt_manifest before the SWE stage runs.',
    ],
    assumptions: [
      'This regression fixture only needs to verify routing and QA coherence.',
    ],
    risks: [
      {
        risk: 'The typed stack could fail to compile before the worker runs.',
        likelihood: 'low',
        mitigation:
          'Assert the written manifest is compiled before checking SWE and QA artifacts.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: `Inspect the compiled manifest artifact for the resolved ${label} stack.`,
        tool: 'file_read',
        target: 'runs/latest/01_manifest.json',
        rationale:
          'Confirms Stage 1 produced a compiled manifest before execution planning proceeds.',
        reversible: true,
        verification:
          'The manifest shows compilation_state = compiled and a populated prompt_manifest.',
      },
    ],
    root_cause: 'N/A — regression coverage task',
    out_of_scope: ['Executing CLI tools', 'Modifying repository files'],
  };
}

function personalizeOfflineSwePlan(
  prompt: string,
  lane: 'frontend' | 'backend',
) {
  const plan = buildPipelineV9OfflineSwePlan(lane);
  const parityFixMap = readParityOfflineFixMap();
  if (parityFixMap !== null) {
    return {
      ...plan,
      minimal_action_set: Object.keys(parityFixMap).map((target, index) => ({
        step: index + 1,
        description: `Apply the offline parity fixture repair to ${target}.`,
        tool: 'file_write',
        target,
        rationale:
          'Writes the fixture-provided repair through the governed executor path.',
        reversible: true,
        verification: 'The fixture verifier passes after the file write.',
      })),
    };
  }
  const target = /Only edit ([A-Za-z0-9_./-]+)/i.exec(prompt)?.[1];
  if (!target) return plan;
  return {
    ...plan,
    minimal_action_set: plan.minimal_action_set.map((step) => ({
      ...step,
      target,
    })),
  };
}

function readParityOfflineFixMap(): Record<string, string> | null {
  const raw = process.env['BABEL_PARITY_OFFLINE_FIX_MAP']?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const entries = Object.entries(parsed).filter(
      ([path, content]) => path.length > 0 && typeof content === 'string',
    );
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}

function buildParityOfflineExecutorResponse(
  prompt: string,
): Record<string, unknown> | null {
  const fixMap = readParityOfflineFixMap();
  if (fixMap === null) return null;

  const history = prompt.includes('### EXECUTION HISTORY SO FAR:')
    ? prompt.slice(prompt.indexOf('### EXECUTION HISTORY SO FAR:'))
    : '';
  const completedCount = (
    history.match(/<tool-result tool="file_write"/g) ?? []
  ).length;
  const next = Object.entries(fixMap)[completedCount];
  if (!next) {
    return { type: 'completion', status: 'EXECUTION_COMPLETE' };
  }
  const [target, content] = next;
  return {
    type: 'tool_call',
    thinking: 'Offline parity fixture: apply the approved fixture repair.',
    tool: 'file_write',
    path: target,
    content,
  };
}

function buildPipelineV9OfflineQaPass(lane: 'frontend' | 'backend') {
  return {
    verdict: 'PASS',
    overall_confidence: 5,
    notes:
      lane === 'frontend'
        ? 'Regression fixture plan is sufficient for the verified frontend worker/QA path.'
        : 'Regression fixture plan is sufficient for the verified backend worker/QA path.',
  };
}

function buildPipelineV9OfflineQaReject(lane: 'frontend' | 'backend') {
  return {
    verdict: 'REJECT',
    overall_confidence: 2,
    failures: [
      {
        tag: 'AMBIGUOUS_PLAN',
        severity: 'blocker',
        description:
          'Offline fixture: simulated QA rejection for integration test.',
        step_index: 0,
      },
    ],
    notes: `Simulated QA rejection for ${lane} lane integration test.`,
  };
}

function buildPipelineV9OfflineEvidencePlan(lane: 'frontend' | 'backend') {
  const label = lane === 'frontend' ? 'frontend' : 'backend';
  return {
    plan_version: '1.0',
    plan_type: 'EVIDENCE_REQUEST',
    task_summary: `OBJECTIVE: Gather evidence for the v9 ${label} lane before replanning.`,
    known_facts: ['Evidence is needed before execution can proceed.'],
    assumptions: ['Evidence will be gathered and fed back to the pipeline.'],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read relevant configuration files.',
        tool: 'file_read',
        target: 'runs/latest/01_manifest.json',
        rationale: 'Gather context before replanning.',
        reversible: true,
        verification: 'File content is non-empty.',
      },
    ],
    root_cause: 'Insufficient context for implementation plan.',
    out_of_scope: ['Modifying files'],
  };
}

export function buildPipelineV9OfflineFixtureResponse(
  prompt: string,
  options: RunOptions,
): unknown | null {
  if (process.env['BABEL_PIPELINE_V9_OFFLINE'] !== '1') {
    return null;
  }

  const stage = options.stage ?? options.mode;
  if ((stage as string) === 'orchestrator') {
    return buildPipelineV9OfflineOrchestratorManifest(prompt);
  }
  const isEpisodeIntegration =
    process.env['BABEL_EPISODE_STREAM_INTEGRATION'] === '1' ||
    /BABEL_EPISODE_STREAM_INTEGRATION/i.test(prompt);
  if (isEpisodeIntegration && stage === 'planning') {
    const plan = buildPipelineV9OfflineSwePlan('backend');
    return {
      ...plan,
      minimal_action_set: [
        {
          ...plan.minimal_action_set[0],
          target: 'src/evidence/episodeStream.ts',
        },
      ],
    };
  }
  if (isEpisodeIntegration && stage === 'qa') {
    return {
      verdict: 'PASS',
      overall_confidence: 5,
      notes: 'Episode stream integration fixture passed QA.',
    };
  }
  if (
    isEpisodeIntegration &&
    (stage === 'executor' || prompt.includes('EXECUTION HISTORY'))
  ) {
    const hasSuccessfulRead =
      /file_read[^\n]*src\/evidence\/episodeStream\.ts[^\n]*\r?\nExit code: 0/.test(
        prompt,
      );
    return hasSuccessfulRead
      ? { type: 'completion', status: 'EXECUTION_COMPLETE' }
      : {
          type: 'tool_call',
          thinking: 'Read the episode stream source before completing.',
          tool: 'file_read',
          path: 'src/evidence/episodeStream.ts',
        };
  }
  const isOtelRegression =
    /otel regression|otel verified lane|otel autonomous lane/i.test(prompt);

  if (isOtelRegression) {
    if (
      stage === 'orchestrator' ||
      prompt.includes(
        'Analyze the task below and output the orchestration manifest',
      )
    ) {
      const mode = 'deep';
      const repoRoot =
        process.env['BABEL_PROJECT_ROOT']?.trim() || process.cwd();
      return buildOtelOfflineOrchestratorManifest(mode, repoRoot);
    }
    if (stage === 'planning' || prompt.includes('produce the SWE Plan')) {
      return buildOtelOfflineSwePlan();
    }
    if (stage === 'qa' || prompt.includes('produce a QA verdict')) {
      return {
        verdict: 'PASS',
        overall_confidence: 5,
        notes: 'OTel regression fixture plan is sufficient for trace coverage.',
      };
    }
    if (stage === 'executor') {
      const historyIndex = prompt.indexOf('EXECUTION HISTORY');
      const executionHistory =
        historyIndex >= 0 ? prompt.slice(historyIndex) : '';
      if (
        !/\[Step 1\] file_read[^\n]*babel-cli\/package\.json\r?\nExit code: 0/.test(
          executionHistory,
        )
      ) {
        return {
          type: 'tool_call',
          thinking:
            'OTel offline fixture: read the CLI package metadata before completing.',
          tool: 'file_read',
          path: 'babel-cli/package.json',
        };
      }
      return {
        type: 'completion',
        status: 'EXECUTION_COMPLETE',
      };
    }
    return null;
  }

  const lane = detectPipelineV9OfflineLane(prompt);
  const scenario = getOfflineScenario();

  if (stage === 'planning' || prompt.includes('produce the SWE Plan')) {
    if (scenario === 'evidence_loop') {
      // Check if this is a replan after evidence gathering
      if (
        prompt.includes('EVIDENCE_REQUEST') ||
        prompt.includes('evidence gathered')
      ) {
        return buildPipelineV9OfflineSwePlan(lane);
      }
      return buildPipelineV9OfflineEvidencePlan(lane);
    }
    return personalizeOfflineSwePlan(prompt, lane);
  }
  if (stage === 'qa' || prompt.includes('produce a QA verdict')) {
    const callNum = incrementQaCallCount();
    if (scenario === 'qa_reject_once') {
      // First call: REJECT, subsequent calls: PASS
      return callNum === 1
        ? buildPipelineV9OfflineQaReject(lane)
        : buildPipelineV9OfflineQaPass(lane);
    }
    if (scenario === 'qa_reject_max') {
      return buildPipelineV9OfflineQaReject(lane);
    }
    return buildPipelineV9OfflineQaPass(lane);
  }
  if (stage === 'executor') {
    const parityExecutorResponse = buildParityOfflineExecutorResponse(prompt);
    if (parityExecutorResponse !== null) return parityExecutorResponse;
    return {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    };
  }

  return null;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function getReliabilityRepairProofVerifierExitCodes(prompt: string): number[] {
  const exitCodes: number[] = [];
  const pattern =
    /\[Step \d+\] (?:test_run|shell_exec)\s+[^\r\n]*?node --test[^\r\n]*\r?\nExit code: (-?\d+)/g;
  for (const match of prompt.matchAll(pattern)) {
    const parsed = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(parsed)) {
      exitCodes.push(parsed);
    }
  }
  return exitCodes;
}

export function buildReliabilityRepairProofExecutorResponse(
  prompt: string,
  options: RunOptions,
): unknown | null {
  if (
    options.stage !== 'executor' ||
    process.env['BABEL_RELIABILITY_REPAIR_PROOF'] !== 'true' ||
    !prompt.includes(RELIABILITY_REPAIR_PROOF_MARKER) ||
    !prompt.includes('src/math.js') ||
    !prompt.includes('node --test')
  ) {
    return null;
  }

  const fileReadCount = countMatches(
    prompt,
    /\[Step \d+\] file_read\s+[^\r\n]*src\/math\.js\r?\nExit code: 0/g,
  );
  const writeCount = countMatches(
    prompt,
    /\[Step \d+\] file_write\s+[^\r\n]*src\/math\.js\r?\nExit code: 0/g,
  );
  const verifierExitCodes = getReliabilityRepairProofVerifierExitCodes(prompt);
  const failedVerifierCount = verifierExitCodes.filter(
    (code) => code !== 0,
  ).length;
  const lastVerifierExitCode = verifierExitCodes[verifierExitCodes.length - 1];
  const hasFailureCapsule =
    /Failure capsule id:\s*repair_failure_capsule_attempt_\d+/.test(prompt);
  const forceStillFail =
    process.env['BABEL_RELIABILITY_REPAIR_PROOF_FORCE_STILL_FAIL'] === 'true';

  if (fileReadCount === 0) {
    return {
      type: 'tool_call',
      thinking:
        'Deterministic reliability proof model-boundary response: honor the approved preflight read before editing.',
      tool: 'file_read',
      path: 'src/math.js',
    };
  }

  if (writeCount === 0) {
    return {
      type: 'tool_call',
      thinking:
        'Deterministic reliability proof model-boundary response: attempt 1 writes the wrong implementation through file_write.',
      tool: 'file_write',
      path: 'src/math.js',
      content: ['export function add(a, b) {', '  return a * b;', '}', ''].join(
        '\n',
      ),
    };
  }

  if (writeCount > verifierExitCodes.length) {
    return {
      type: 'tool_call',
      thinking:
        'Run the verifier through the normal test_run path before completing.',
      tool: 'test_run',
      command: 'node --test',
      working_directory: '.',
      timeout_seconds: 120,
    };
  }

  if (lastVerifierExitCode !== undefined && lastVerifierExitCode !== 0) {
    if (!hasFailureCapsule) {
      return {
        type: 'completion',
        status: 'EXECUTION_HALTED',
        halt_tag: 'STEP_VERIFICATION_FAIL',
        condition:
          'Reliability repair proof cannot continue: verifier failed but no failure capsule was present in the executor prompt.',
      };
    }

    return {
      type: 'tool_call',
      thinking: [
        'Deterministic reliability proof model-boundary response:',
        'consume the real failure capsule from the executor prompt and patch src/math.js before rerunning the same verifier.',
      ].join(' '),
      tool: 'file_write',
      path: 'src/math.js',
      content: forceStillFail
        ? [
            'export function add(a, b) {',
            `  return a * b; // forced failure retry ${failedVerifierCount + 1}`,
            '}',
            '',
          ].join('\n')
        : ['export function add(a, b) {', '  return a + b;', '}', ''].join(
            '\n',
          ),
    };
  }

  if (lastVerifierExitCode === 0 && failedVerifierCount > 0) {
    return {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    };
  }

  return {
    type: 'completion',
    status: 'EXECUTION_HALTED',
    halt_tag: 'STEP_VERIFICATION_FAIL',
    condition:
      'Reliability repair proof reached an unexpected executor prompt state.',
  };
}
