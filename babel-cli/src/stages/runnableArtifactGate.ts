import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { HaltTag, ToolCallLog } from '../schemas/agentContracts.js';
import type { RuntimeVerificationResult } from './runtimeVerificationRunner.js';

export type RunnableArtifactGateStatus =
  | 'PASS'
  | 'FAIL_REPAIRABLE'
  | 'FAIL_UNREPAIRABLE'
  | 'SKIPPED_WITH_REASON';

export interface RunnableArtifactCheck {
  id: string;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
  evidence?: string[];
  next_repair_action?: string;
}

export interface RunnableArtifactGateResult {
  gate: 'runnable_artifact';
  target_type: 'godot' | 'unknown';
  status: RunnableArtifactGateStatus;
  reason: string;
  verification_command: string | null;
  failed_artifact_checks: RunnableArtifactCheck[];
  evidence_lines: string[];
  next_repair_action: string | null;
  checks: RunnableArtifactCheck[];
}

export interface RunnableArtifactGateInput {
  rawTask: string;
  projectRoot: string | null;
  toolCallLog: readonly ToolCallLog[];
  runtimeVerification?: RuntimeVerificationResult | null;
}

export interface RunnableArtifactHaltDecision {
  haltTag: HaltTag;
  condition: string;
}

const GODOT_ERROR_PATTERNS = [
  /\bERROR:/i,
  /\bError parsing\b/i,
  /\bCouldn't load\b/i,
  /\bFailed loading resource\b/i,
  /\bparse error\b/i,
  /\bresource .*not found\b/i,
  /\bInvalid\/corrupt\b/i,
  /\bFile might be corrupted\b/i,
] as const;

function isKnownGodotTarget(input: RunnableArtifactGateInput): boolean {
  const task = input.rawTask;
  if (/\bgodot\b/i.test(task) && /\b(?:game|mobile|android|prototype|app)\b/i.test(task)) {
    return true;
  }
  if (input.projectRoot && existsSync(join(input.projectRoot, 'project.godot'))) {
    return true;
  }
  return input.toolCallLog.some((entry) => {
    const target = String(entry.target ?? '');
    return (
      /(?:^|[\\/])project\.godot$/i.test(target) ||
      /\.(?:tscn|gd)$/i.test(target) ||
      /export_presets\.cfg$/i.test(target)
    );
  });
}

function makeCheck(
  id: string,
  status: RunnableArtifactCheck['status'],
  message: string,
  evidence: string[] = [],
  nextRepairAction?: string,
): RunnableArtifactCheck {
  return {
    id,
    status,
    message,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(nextRepairAction ? { next_repair_action: nextRepairAction } : {}),
  };
}

function readTextIfFile(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  return readFileSync(path, 'utf-8');
}

function extractGodotMainScene(projectText: string): string | null {
  const match =
    /(?:^|\n)\s*run\/main_scene\s*=\s*"res:\/\/([^"]+)"/i.exec(projectText) ??
    /(?:^|\n)\s*main_scene\s*=\s*"res:\/\/([^"]+)"/i.exec(projectText);
  return match?.[1]?.trim() || null;
}

function projectGodotMalformedEvidence(projectText: string): string[] {
  const evidence: string[] = [];
  if (projectText.trim().length === 0) {
    evidence.push('project.godot is empty.');
  }
  if (!/^\s*\[[^\]]+\]/m.test(projectText)) {
    evidence.push('project.godot has no section headers.');
  }
  if (/(?:^|\n)\s*(?:run\/)?main_scene\s*=\s*res:\/\//i.test(projectText)) {
    evidence.push('project.godot contains an unquoted res:// main_scene value.');
  }
  return evidence;
}

function lastSuccessfulMutationIndex(toolCallLog: readonly ToolCallLog[]): number {
  return (
    toolCallLog
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.tool === 'file_write' && entry.exit_code === 0)
      .at(-1)?.index ?? -1
  );
}

function isGodotHeadlessCommand(command: string): boolean {
  return (
    /\bgodot(?:\.\w+)?\b/i.test(command) &&
    /(?:^|\s)--headless(?:\s|$)/i.test(command) &&
    /(?:^|\s)--path(?:\s|$)/i.test(command)
  );
}

function findPostMutationGodotVerification(
  toolCallLog: readonly ToolCallLog[],
): ToolCallLog | null {
  const lastMutation = lastSuccessfulMutationIndex(toolCallLog);
  const candidates = toolCallLog.slice(Math.max(0, lastMutation + 1));
  return (
    candidates.find(
      (entry) =>
        (entry.tool === 'shell_exec' || entry.tool === 'test_run') &&
        isGodotHeadlessCommand(String(entry.target ?? '')),
    ) ?? null
  );
}

function collectMatchingEvidenceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => GODOT_ERROR_PATTERNS.some((pattern) => pattern.test(line)))
    .slice(0, 8);
}

function finalizeGodotResult(
  checks: RunnableArtifactCheck[],
  verificationCommand: string | null,
): RunnableArtifactGateResult {
  const failed = checks.filter((check) => check.status === 'fail');
  if (failed.length === 0) {
    return {
      gate: 'runnable_artifact',
      target_type: 'godot',
      status: 'PASS',
      reason: 'Godot runnable artifact checks passed.',
      verification_command: verificationCommand,
      failed_artifact_checks: [],
      evidence_lines: [],
      next_repair_action: null,
      checks,
    };
  }

  const evidenceLines = [...new Set(failed.flatMap((check) => check.evidence ?? []))];
  const nextRepairAction =
    failed.find((check) => check.next_repair_action)?.next_repair_action ??
    'Repair the Godot scaffold, rerun Godot headless verification, then retry completion.';
  const status: RunnableArtifactGateStatus = failed.some(
    (check) => check.id === 'PROJECT_ROOT_UNAVAILABLE',
  )
    ? 'FAIL_UNREPAIRABLE'
    : 'FAIL_REPAIRABLE';

  return {
    gate: 'runnable_artifact',
    target_type: 'godot',
    status,
    reason: failed.map((check) => `${check.id}: ${check.message}`).join(' | '),
    verification_command: verificationCommand,
    failed_artifact_checks: failed,
    evidence_lines: evidenceLines,
    next_repair_action: nextRepairAction,
    checks,
  };
}

function evaluateGodotRunnableArtifact(
  input: RunnableArtifactGateInput,
): RunnableArtifactGateResult {
  const checks: RunnableArtifactCheck[] = [];
  if (!input.projectRoot) {
    checks.push(
      makeCheck(
        'PROJECT_ROOT_UNAVAILABLE',
        'fail',
        'Godot artifact validation requires a project root.',
        [],
        'Run the task with a resolved project root before accepting completion.',
      ),
    );
    return finalizeGodotResult(checks, null);
  }

  const projectFile = join(input.projectRoot, 'project.godot');
  const projectText = readTextIfFile(projectFile);
  if (projectText === null) {
    checks.push(
      makeCheck(
        'GODOT_PROJECT_MISSING',
        'fail',
        'project.godot is missing at the target root.',
        [`Missing: ${projectFile}`],
        'Create a valid root project.godot file for the Godot project.',
      ),
    );
  } else {
    const malformedEvidence = projectGodotMalformedEvidence(projectText);
    checks.push(
      makeCheck(
        'GODOT_PROJECT_WELL_FORMED',
        malformedEvidence.length === 0 ? 'pass' : 'fail',
        malformedEvidence.length === 0
          ? 'project.godot appears non-empty and parseable by static checks.'
          : 'project.godot appears malformed or empty.',
        malformedEvidence,
        malformedEvidence.length > 0
          ? 'Regenerate project.godot with valid Godot project settings syntax.'
          : undefined,
      ),
    );

    const mainScene = extractGodotMainScene(projectText);
    checks.push(
      makeCheck(
        'GODOT_MAIN_SCENE_DEFINED',
        mainScene ? 'pass' : 'fail',
        mainScene
          ? `project.godot defines main scene res://${mainScene}.`
          : 'project.godot does not define application/run/main_scene.',
        mainScene ? [] : ['Missing run/main_scene="res://scenes/Main.tscn" in project.godot.'],
        mainScene ? undefined : 'Set application/run/main_scene to res://scenes/Main.tscn.',
      ),
    );

    if (mainScene) {
      const mainScenePath = join(input.projectRoot, mainScene);
      checks.push(
        makeCheck(
          'GODOT_CONFIGURED_MAIN_SCENE_EXISTS',
          existsSync(mainScenePath) && statSync(mainScenePath).isFile() ? 'pass' : 'fail',
          `Configured main scene exists at ${mainScene}.`,
          existsSync(mainScenePath) ? [] : [`Missing: ${mainScenePath}`],
          existsSync(mainScenePath)
            ? undefined
            : `Create the configured main scene at ${mainScene}.`,
        ),
      );
    }
  }

  const requiredMobileMainScene = join(input.projectRoot, 'scenes', 'Main.tscn');
  checks.push(
    makeCheck(
      'GODOT_MOBILE_MAIN_SCENE_EXISTS',
      existsSync(requiredMobileMainScene) && statSync(requiredMobileMainScene).isFile()
        ? 'pass'
        : 'fail',
      'Godot mobile game scaffold includes scenes/Main.tscn.',
      existsSync(requiredMobileMainScene) ? [] : [`Missing: ${requiredMobileMainScene}`],
      existsSync(requiredMobileMainScene)
        ? undefined
        : 'Create scenes/Main.tscn and point project.godot run/main_scene at it.',
    ),
  );

  const runtimeVerification =
    input.runtimeVerification?.targetType === 'godot' ? input.runtimeVerification : null;
  const verification = runtimeVerification
    ? null
    : findPostMutationGodotVerification(input.toolCallLog);
  const verificationCommand =
    runtimeVerification?.command ?? (verification ? String(verification.target ?? '') : null);
  if (runtimeVerification) {
    if (runtimeVerification.status === 'PASS') {
      checks.push(
        makeCheck(
          'GODOT_HEADLESS_VERIFICATION_PASSED',
          'pass',
          'Babel-owned Godot headless verification passed.',
        ),
      );
      return finalizeGodotResult(checks, verificationCommand);
    }

    if (runtimeVerification.status === 'TOOL_UNAVAILABLE') {
      checks.push(
        makeCheck(
          'VERIFICATION_TOOL_UNAVAILABLE',
          'fail',
          runtimeVerification.reason,
          runtimeVerification.detectedErrors,
          'Install or configure the Godot wrapper, then rerun completion verification.',
        ),
      );
      return finalizeGodotResult(checks, verificationCommand);
    }

    if (runtimeVerification.status === 'FAIL') {
      checks.push(
        makeCheck(
          'GODOT_HEADLESS_VERIFICATION_FAILED',
          'fail',
          runtimeVerification.reason,
          runtimeVerification.detectedErrors.length > 0
            ? runtimeVerification.detectedErrors
            : [
                ...(runtimeVerification.stdoutExcerpt ? [runtimeVerification.stdoutExcerpt] : []),
                ...(runtimeVerification.stderrExcerpt ? [runtimeVerification.stderrExcerpt] : []),
              ].slice(0, 4),
          'Repair the Godot project until Babel-owned headless verification exits 0 without parse/load/resource errors.',
        ),
      );
      return finalizeGodotResult(checks, verificationCommand);
    }
  }

  if (!verification) {
    checks.push(
      makeCheck(
        'NO_RUNTIME_VERIFICATION',
        'fail',
        'No Godot headless verification ran after the final file write.',
        [],
        'Run godot --headless --path <project-root> --quit after the final mutation.',
      ),
    );
    return finalizeGodotResult(checks, verificationCommand);
  }

  const verificationOutput = [verification.stdout, verification.stderr].filter(Boolean).join('\n');
  const evidenceLines = collectMatchingEvidenceLines(verificationOutput);
  if (verification.exit_code !== 0 || evidenceLines.length > 0) {
    checks.push(
      makeCheck(
        'GODOT_HEADLESS_VERIFICATION_FAILED',
        'fail',
        verification.exit_code === 0
          ? 'Godot headless verification output contains parse/load/resource errors.'
          : `Godot headless verification exited with code ${verification.exit_code}.`,
        evidenceLines.length > 0 ? evidenceLines : [`exit_code=${verification.exit_code}`],
        'Repair the Godot project until headless verification exits 0 without parse/load/resource errors.',
      ),
    );
  } else {
    checks.push(
      makeCheck(
        'GODOT_HEADLESS_VERIFICATION_PASSED',
        'pass',
        'Godot headless verification ran after the final mutation without detected parse/load/resource errors.',
      ),
    );
  }

  return finalizeGodotResult(checks, verificationCommand);
}

export function evaluateRunnableArtifactGate(
  input: RunnableArtifactGateInput,
): RunnableArtifactGateResult {
  if (!isKnownGodotTarget(input)) {
    return {
      gate: 'runnable_artifact',
      target_type: 'unknown',
      status: 'SKIPPED_WITH_REASON',
      reason: 'No known runnable artifact target type was detected.',
      verification_command: null,
      failed_artifact_checks: [],
      evidence_lines: [],
      next_repair_action: null,
      checks: [
        makeCheck(
          'TARGET_TYPE_UNKNOWN',
          'skipped',
          'Runnable artifact gate currently supports Godot targets only.',
        ),
      ],
    };
  }

  return evaluateGodotRunnableArtifact(input);
}

export function runnableArtifactGateBlocksCompletion(result: RunnableArtifactGateResult): boolean {
  return result.status === 'FAIL_REPAIRABLE' || result.status === 'FAIL_UNREPAIRABLE';
}

export function runnableArtifactGateHaltDecision(
  result: RunnableArtifactGateResult,
): RunnableArtifactHaltDecision {
  const failedChecks = result.failed_artifact_checks.map(
    (check) => `- ${check.id}: ${check.message}`,
  );
  const evidenceLines =
    result.evidence_lines.length > 0
      ? result.evidence_lines.map((line) => `- ${line}`)
      : ['- No runtime evidence lines were available.'];
  return {
    haltTag: result.failed_artifact_checks.some(
      (check) => check.id === 'VERIFICATION_TOOL_UNAVAILABLE',
    )
      ? 'VERIFICATION_TOOL_UNAVAILABLE'
      : 'REPAIR_REQUIRED_ARTIFACT_INVALID',
    condition: [
      result.failed_artifact_checks.some((check) => check.id === 'VERIFICATION_TOOL_UNAVAILABLE')
        ? 'EXECUTION_HALTED_VERIFICATION_TOOL_UNAVAILABLE'
        : 'EXECUTION_HALTED_ARTIFACT_INVALID',
      `Runnable Artifact Gate status: ${result.status}`,
      `Target type: ${result.target_type}`,
      'Failed artifact checks:',
      ...(failedChecks.length > 0 ? failedChecks : ['- None']),
      `Verification command: ${result.verification_command ?? 'NO_RUNTIME_VERIFICATION'}`,
      'Relevant evidence lines:',
      ...evidenceLines,
      `Next repair action: ${result.next_repair_action ?? 'Repair artifact validity and rerun verification.'}`,
    ].join('\n'),
  };
}
