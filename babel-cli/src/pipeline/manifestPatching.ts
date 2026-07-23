import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { OrchestratorManifest, PipelineMode } from '../schemas/agentContracts.js';
import { isExternalBenchmarkTask } from './benchmarkTasks.js';
import { mergeTaskContext } from '../stages/taskShape.js';

export function inferDeterministicDomainId(
  task: string,
): { domainId: string; reason: string } | null {
  const text = String(task ?? '');
  const normalized = text.replace(/\\/g, '/').toLowerCase();

  if (
    /\bterminal-bench 2 task:\s*break-filter-js-from-html\b/i.test(normalized) ||
    (/\bterminal-bench 2 task\b/i.test(normalized) &&
      /\b(?:filter\.py|test_outputs\.py|out\.html|javascript alert|xss|html file)\b/i.test(
        normalized,
      ))
  ) {
    return {
      domainId: 'domain_python_backend',
      reason:
        'Terminal-Bench HTML sanitizer task requires Python/validator routing, not game routing',
    };
  }

  if (
    /\.(?:gd|tscn|tres)\b/i.test(normalized) ||
    /\b(?:project\.godot|export_presets\.cfg|godot|gdscript|inputmap|canvaslayer|tilemap)\b/i.test(
      normalized,
    )
  ) {
    return {
      domainId: 'domain_godot_game_dev',
      reason: 'task references Godot/GDScript game artifacts',
    };
  }

  if (
    /\bapp\/src\/main\/java\/.+\.(kt|java)\b/i.test(normalized) ||
    /\.(kt|java)\b/i.test(normalized)
  ) {
    return {
      domainId: 'domain_android_kotlin',
      reason: 'task references Android/Kotlin or Java source paths',
    };
  }

  if (
    /\bconfig\/[^ \r\n'"`]+\.(?:sh|ps1|yml|yaml)\b/i.test(normalized) ||
    /\b(?:ci\/cd|cicd|deploy(?:ment)?|ops|healthcheck|smoke checks?)\b/i.test(normalized)
  ) {
    return {
      domainId: 'domain_devops',
      reason: 'task references deployment, CI/CD, ops, or healthcheck artifacts',
    };
  }

  if (
    /\bdocs\/[^ \r\n'"`]*(?:evidence|audit|compliance)[^ \r\n'"`]*\.md\b/i.test(normalized) ||
    /\b(?:compliance|audit readiness|control owners?|retention evidence|sign-off)\b/i.test(
      normalized,
    )
  ) {
    return {
      domainId: 'domain_compliance_gpc',
      reason: 'task references compliance or audit evidence artifacts',
    };
  }

  if (
    /\bsrc\/[^ \r\n'"`]+\.(?:css|jsx|tsx)\b/i.test(normalized) ||
    /\bhtml string\b/i.test(normalized)
  ) {
    return {
      domainId: 'domain_swe_frontend',
      reason: 'task references frontend source or rendered HTML/CSS artifacts',
    };
  }

  if (/\bsrc\/[^ \r\n'"`]+\.(?:ts|js|mjs|cjs)\b/i.test(normalized)) {
    return { domainId: 'domain_swe_backend', reason: 'task references general source artifacts' };
  }

  return null;
}

function hasGradleBuildMarkers(projectRoot: string | undefined): boolean {
  if (!projectRoot) {
    return false;
  }
  return [
    'settings.gradle',
    'settings.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
    'gradlew',
    'gradlew.bat',
    'app/build.gradle',
    'app/build.gradle.kts',
  ].some((relativePath) => existsSync(join(projectRoot, relativePath)));
}

export function isAndroidSourceOnlyWorkspace(projectRoot: string | undefined): boolean {
  if (!projectRoot || hasGradleBuildMarkers(projectRoot)) {
    return false;
  }
  return [
    join(projectRoot, 'app', 'src', 'main', 'java'),
    join(projectRoot, 'app', 'src', 'main', 'kotlin'),
  ].some((path) => existsSync(path));
}

export function maybeApplyDeterministicDomainOverride(
  manifest: OrchestratorManifest,
  rawTask: string,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack || !manifest.resolution_policy) {
    return { manifest, warnings: [], applied: false };
  }

  const decision = inferDeterministicDomainId(
    mergeTaskContext(rawTask, manifest.handoff_payload.user_request),
  );
  if (!decision || manifest.instruction_stack.domain_id === decision.domainId) {
    return { manifest, warnings: [], applied: false };
  }

  const nextManifest: OrchestratorManifest = {
    ...manifest,
    analysis: {
      ...manifest.analysis,
      secondary_category:
        manifest.analysis.secondary_category ?? manifest.instruction_stack.domain_id,
    },
    instruction_stack: {
      ...manifest.instruction_stack,
      domain_id: decision.domainId,
      skill_ids: [],
    },
  };

  return {
    manifest: nextManifest,
    warnings: [
      `[DETERMINISTIC_DOMAIN_ROUTE] Overrode orchestrator domain ${manifest.instruction_stack.domain_id} -> ${decision.domainId}: ${decision.reason}.`,
      '[DETERMINISTIC_DOMAIN_ROUTE] Cleared explicit skill_ids so resolver can apply compact domain defaults for the corrected route.',
    ],
    applied: true,
  };
}

const KNOWN_MODEL_ADAPTER_IDS = new Set([
  'adapter_claude',
  'adapter_codex',
  'adapter_codex_balanced',
  'adapter_gemini',
  'adapter_nemotron',
  'adapter_scout',
  'adapter_qwen',
]);

export function maybeApplyModelAdapterFallback(manifest: OrchestratorManifest): {
  manifest: OrchestratorManifest;
  warnings: string[];
  applied: boolean;
} {
  const currentAdapterId = manifest.instruction_stack?.model_adapter_id;
  if (
    !manifest.instruction_stack ||
    !currentAdapterId ||
    KNOWN_MODEL_ADAPTER_IDS.has(currentAdapterId)
  ) {
    return { manifest, warnings: [], applied: false };
  }

  const normalized = currentAdapterId.toLowerCase();
  const assignedModel = manifest.worker_configuration.assigned_model;
  const fallbackAdapter = normalized.includes('claude')
    ? 'adapter_claude'
    : normalized.includes('gemini')
      ? 'adapter_gemini'
      : normalized.includes('qwen') || assignedModel === 'qwen3' || assignedModel === 'qwen3-32b'
        ? 'adapter_qwen'
        : normalized.includes('scout') || assignedModel === 'scout'
          ? 'adapter_scout'
          : normalized.includes('nemotron') || assignedModel === 'nemotron'
            ? 'adapter_nemotron'
            : 'adapter_codex_balanced';

  return {
    manifest: {
      ...manifest,
      instruction_stack: {
        ...manifest.instruction_stack,
        model_adapter_id: fallbackAdapter,
      },
    },
    warnings: [
      `[MODEL_ADAPTER_FALLBACK] Replaced unknown model_adapter_id "${currentAdapterId}" with "${fallbackAdapter}".`,
    ],
    applied: true,
  };
}

export function maybeApplyBenchmarkHarnessOverlay(
  manifest: OrchestratorManifest,
  rawTask: string,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack || !isExternalBenchmarkTask(rawTask)) {
    return { manifest, warnings: [], applied: false };
  }

  const taskOverlayIds = manifest.instruction_stack.task_overlay_ids ?? [];
  if (taskOverlayIds.includes('overlay_terminal_bench')) {
    return { manifest, warnings: [], applied: false };
  }

  return {
    manifest: {
      ...manifest,
      instruction_stack: {
        ...manifest.instruction_stack,
        task_overlay_ids: [...taskOverlayIds, 'overlay_terminal_bench'],
      },
    },
    warnings: [
      '[BENCHMARK_HARNESS_OVERLAY] Added overlay_terminal_bench for benchmark workspace/scoring constraints.',
    ],
    applied: true,
  };
}

export function maybeEnrichPipelineStageIds(
  manifest: OrchestratorManifest,
  pipelineModeOverride?: PipelineMode,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack) {
    return { manifest, warnings: [], applied: false };
  }

  const pipelineMode = pipelineModeOverride ?? manifest.analysis.pipeline_mode;
  const requiredStageIds: string[] = [];
  if (pipelineMode === 'deep') {
    requiredStageIds.push('pipeline_qa_reviewer', 'pipeline_cli_executor');
  } else {
    return { manifest, warnings: [], applied: false };
  }

  const existingStageIds = manifest.instruction_stack.pipeline_stage_ids ?? [];
  const missingStageIds = requiredStageIds.filter((stageId) => !existingStageIds.includes(stageId));
  if (missingStageIds.length === 0) {
    return { manifest, warnings: [], applied: false };
  }

  return {
    manifest: {
      ...manifest,
      instruction_stack: {
        ...manifest.instruction_stack,
        pipeline_stage_ids: [...existingStageIds, ...missingStageIds],
      },
    },
    warnings: [
      `[PIPELINE_STAGE_ENRICHMENT] Appended missing pipeline stages for ${pipelineMode}: ${missingStageIds.join(', ')}.`,
    ],
    applied: true,
  };
}

export function maybeApplyBenchmarkRoutingIsolation(
  manifest: OrchestratorManifest,
  rawTask: string,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!isExternalBenchmarkTask(rawTask)) {
    return { manifest, warnings: [], applied: false };
  }

  const nextInstructionStack = manifest.instruction_stack
    ? {
        ...manifest.instruction_stack,
        project_overlay_id: null,
      }
    : manifest.instruction_stack;
  const nextManifest: OrchestratorManifest = {
    ...manifest,
    target_project: 'global',
    ...(nextInstructionStack ? { instruction_stack: nextInstructionStack } : {}),
  };

  const applied =
    manifest.target_project !== 'global' || manifest.instruction_stack?.project_overlay_id !== null;

  return {
    manifest: applied ? nextManifest : manifest,
    warnings: applied
      ? [
          `[BENCHMARK_ROUTING_ISOLATION] Routed external benchmark task through global benchmark context instead of workspace project "${manifest.target_project}".`,
          '[BENCHMARK_ROUTING_ISOLATION] Cleared project overlay so Terminal-Bench app roots do not inherit unrelated workspace project context.',
        ]
      : [],
    applied,
  };
}
