import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import {
  evaluateRunnableArtifactGate,
  runnableArtifactGateBlocksCompletion,
  type RunnableArtifactGateResult,
} from './runnableArtifactGate.js';
import {
  runRuntimeVerification,
  type RuntimeVerificationResult,
  type RuntimeVerificationRunnerInput,
} from './runtimeVerificationRunner.js';
import {
  GODOT_MOBILE_SCAFFOLD_FILES,
  defaultGodotMobileScaffoldTemplate,
} from './godotScaffoldSeeder.js';

export type GodotArtifactRepairStatus = 'REPAIRED' | 'NOOP' | 'UNSUPPORTED' | 'FAILED';

export type GodotArtifactRepairLoopStatus =
  | 'REPAIRED_AND_COMPLETE'
  | 'REPAIR_REQUIRED_ARTIFACT_INVALID'
  | 'EXECUTION_HALTED_ARTIFACT_INVALID'
  | 'EXECUTION_HALTED_REPAIR_BUDGET_EXCEEDED'
  | 'EXECUTION_HALTED_VERIFICATION_TOOL_UNAVAILABLE';

export interface GodotArtifactRepairAttempt {
  stage: 'godot_artifact_repair';
  attempt: number;
  targetType: 'godot' | 'unknown';
  targetRoot: string | null;
  scaffoldTemplate: string | null;
  repairClasses: string[];
  filesCopied: string[];
  filesModified: string[];
  filesSkipped: string[];
  status: GodotArtifactRepairStatus;
  reason: string;
  timestamp: string;
}

export interface GodotArtifactRepairAttemptEvidence {
  repair: GodotArtifactRepairAttempt;
  runtimeVerification: RuntimeVerificationResult;
  runnableArtifactGate: RunnableArtifactGateResult;
}

export interface GodotArtifactRepairLoopResult {
  status: GodotArtifactRepairLoopStatus;
  attempts: GodotArtifactRepairAttemptEvidence[];
  finalRuntimeVerification: RuntimeVerificationResult | null;
  finalGate: RunnableArtifactGateResult;
  reason: string;
}

export interface GodotArtifactRepairInput {
  rawTask: string;
  projectRoot: string | null;
  toolCallLog: readonly ToolCallLog[];
  initialGate: RunnableArtifactGateResult;
  babelRoot: string;
  maxRepairAttempts?: number;
  scaffoldTemplate?: string;
  now?: () => Date;
  runVerification?: (input: RuntimeVerificationRunnerInput) => RuntimeVerificationResult;
  evaluateGate?: typeof evaluateRunnableArtifactGate;
}

const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }
  return readFileSync(path, 'utf-8');
}

function copyTemplateFile(
  templateRoot: string,
  targetRoot: string,
  relativePath: string,
  filesCopied: string[],
  filesSkipped: string[],
): void {
  const source = join(templateRoot, relativePath);
  const destination = join(targetRoot, relativePath);
  if (existsSync(destination)) {
    filesSkipped.push(relativePath);
    return;
  }
  if (!existsSync(source) || !statSync(source).isFile()) {
    filesSkipped.push(relativePath);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  filesCopied.push(relativePath);
}

function hasSectionHeaders(projectText: string): boolean {
  return /^\s*\[[^\]]+\]/m.test(projectText);
}

function hasQuotedMainScene(projectText: string): boolean {
  return /(?:^|\n)\s*(?:run\/)?main_scene\s*=\s*"res:\/\/[^"]+"/i.test(projectText);
}

function hasUnquotedMainScene(projectText: string): boolean {
  return /(?:^|\n)\s*(?:run\/)?main_scene\s*=\s*res:\/\//i.test(projectText);
}

function safeToReplaceProjectGodot(projectText: string | null): boolean {
  if (projectText === null) {
    return true;
  }
  const trimmed = projectText.trim();
  return (
    trimmed.length === 0 || !hasSectionHeaders(projectText) || hasUnquotedMainScene(projectText)
  );
}

function ensureMainSceneConfig(projectText: string): string {
  const desired = 'run/main_scene="res://scenes/Main.tscn"';
  if (/(?:^|\n)\s*(?:run\/)?main_scene\s*=/i.test(projectText)) {
    return projectText.replace(
      /(^|\n)(\s*)(?:run\/)?main_scene\s*=\s*(?:"res:\/\/[^"]+"|res:\/\/[^\r\n]+)/i,
      `$1$2${desired}`,
    );
  }

  if (/^\s*\[application\]\s*$/im.test(projectText)) {
    return projectText.replace(/(^\s*\[application\]\s*$)/im, `$1\n${desired}`);
  }

  const separator = projectText.endsWith('\n') ? '\n' : '\n\n';
  return `${projectText}${separator}[application]\n${desired}\n`;
}

function writeTemplateProjectGodot(
  templateRoot: string,
  targetRoot: string,
  filesModified: string[],
): boolean {
  const source = join(templateRoot, 'project.godot');
  const destination = join(targetRoot, 'project.godot');
  if (!existsSync(source) || !statSync(source).isFile()) {
    return false;
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  filesModified.push('project.godot');
  return true;
}

function collectRepairClasses(gate: RunnableArtifactGateResult): string[] {
  const classes = new Set<string>();
  for (const check of gate.failed_artifact_checks) {
    if (check.id === 'GODOT_PROJECT_MISSING') {
      classes.add('missing_project_godot');
    }
    if (check.id === 'GODOT_PROJECT_WELL_FORMED') {
      classes.add('malformed_project_godot');
    }
    if (check.id === 'GODOT_MAIN_SCENE_DEFINED') {
      classes.add('missing_main_scene_config');
    }
    if (
      check.id === 'GODOT_CONFIGURED_MAIN_SCENE_EXISTS' ||
      check.id === 'GODOT_MOBILE_MAIN_SCENE_EXISTS'
    ) {
      classes.add('missing_main_scene');
    }
    if (check.id === 'GODOT_HEADLESS_VERIFICATION_FAILED') {
      classes.add('runtime_bootstrap_failure');
    }
  }
  return [...classes];
}

export function repairGodotBootstrapArtifacts(input: {
  gate: RunnableArtifactGateResult;
  projectRoot: string | null;
  babelRoot: string;
  attempt: number;
  scaffoldTemplate?: string;
  now?: () => Date;
}): GodotArtifactRepairAttempt {
  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const repairClasses = collectRepairClasses(input.gate);
  const targetRoot = input.projectRoot ? resolve(input.projectRoot) : null;
  const scaffoldTemplate = resolve(
    input.scaffoldTemplate ?? defaultGodotMobileScaffoldTemplate(input.babelRoot),
  );
  const base = {
    stage: 'godot_artifact_repair' as const,
    attempt: input.attempt,
    targetType: input.gate.target_type,
    targetRoot,
    scaffoldTemplate,
    repairClasses,
    filesCopied: [] as string[],
    filesModified: [] as string[],
    filesSkipped: [] as string[],
    timestamp,
  };

  if (input.gate.target_type !== 'godot' || input.gate.status !== 'FAIL_REPAIRABLE') {
    return {
      ...base,
      status: 'UNSUPPORTED',
      reason: 'Artifact repair only supports repairable Godot gate failures.',
    };
  }
  if (!targetRoot) {
    return {
      ...base,
      status: 'UNSUPPORTED',
      reason: 'Godot artifact repair requires a resolved target root.',
    };
  }
  if (!existsSync(scaffoldTemplate) || !statSync(scaffoldTemplate).isDirectory()) {
    return {
      ...base,
      status: 'FAILED',
      reason: `Godot scaffold template is unavailable at ${scaffoldTemplate}.`,
    };
  }

  mkdirSync(targetRoot, { recursive: true });

  for (const relativePath of GODOT_MOBILE_SCAFFOLD_FILES) {
    if (relativePath === 'project.godot') {
      continue;
    }
    copyTemplateFile(
      scaffoldTemplate,
      targetRoot,
      relativePath,
      base.filesCopied,
      base.filesSkipped,
    );
  }

  const projectPath = join(targetRoot, 'project.godot');
  const projectText = readText(projectPath);
  if (projectText === null) {
    copyTemplateFile(
      scaffoldTemplate,
      targetRoot,
      'project.godot',
      base.filesCopied,
      base.filesSkipped,
    );
  } else if (safeToReplaceProjectGodot(projectText)) {
    if (!writeTemplateProjectGodot(scaffoldTemplate, targetRoot, base.filesModified)) {
      base.filesSkipped.push('project.godot');
    }
  } else if (!hasQuotedMainScene(projectText)) {
    const repaired = ensureMainSceneConfig(projectText);
    if (repaired !== projectText) {
      writeFileSync(projectPath, repaired, 'utf-8');
      base.filesModified.push('project.godot');
    } else {
      base.filesSkipped.push('project.godot');
    }
  } else {
    base.filesSkipped.push('project.godot');
  }

  const changed = base.filesCopied.length + base.filesModified.length;
  return {
    ...base,
    status: changed > 0 ? 'REPAIRED' : 'NOOP',
    reason:
      changed > 0
        ? 'Known Godot bootstrap files were repaired from the deterministic scaffold.'
        : 'No deterministic Godot bootstrap repair was available.',
  };
}

export function runGodotArtifactRepairLoop(
  input: GodotArtifactRepairInput,
): GodotArtifactRepairLoopResult {
  const maxRepairAttempts = input.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  const runVerification = input.runVerification ?? runRuntimeVerification;
  const evaluateGate = input.evaluateGate ?? evaluateRunnableArtifactGate;
  let finalGate = input.initialGate;
  let finalRuntimeVerification: RuntimeVerificationResult | null = null;
  const attempts: GodotArtifactRepairAttemptEvidence[] = [];

  if (finalGate.target_type !== 'godot') {
    return {
      status: 'EXECUTION_HALTED_ARTIFACT_INVALID',
      attempts,
      finalRuntimeVerification,
      finalGate,
      reason: 'Artifact repair loop only supports Godot targets.',
    };
  }

  for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
    if (!runnableArtifactGateBlocksCompletion(finalGate)) {
      return {
        status:
          finalRuntimeVerification?.status === 'PASS'
            ? 'REPAIRED_AND_COMPLETE'
            : 'REPAIR_REQUIRED_ARTIFACT_INVALID',
        attempts,
        finalRuntimeVerification,
        finalGate,
        reason: 'Runnable Artifact Gate no longer blocks completion.',
      };
    }

    if (
      finalGate.failed_artifact_checks.some((check) => check.id === 'VERIFICATION_TOOL_UNAVAILABLE')
    ) {
      return {
        status: 'EXECUTION_HALTED_VERIFICATION_TOOL_UNAVAILABLE',
        attempts,
        finalRuntimeVerification,
        finalGate,
        reason:
          'Godot verification tool is unavailable; deterministic artifact repair cannot prove runtime validity.',
      };
    }

    const repairInput: Parameters<typeof repairGodotBootstrapArtifacts>[0] = {
      gate: finalGate,
      projectRoot: input.projectRoot,
      babelRoot: input.babelRoot,
      attempt,
    };
    if (input.scaffoldTemplate !== undefined) {
      repairInput.scaffoldTemplate = input.scaffoldTemplate;
    }
    if (input.now !== undefined) {
      repairInput.now = input.now;
    }
    const repair = repairGodotBootstrapArtifacts(repairInput);
    if (repair.status !== 'REPAIRED') {
      return {
        status:
          finalGate.status === 'FAIL_UNREPAIRABLE'
            ? 'EXECUTION_HALTED_ARTIFACT_INVALID'
            : 'REPAIR_REQUIRED_ARTIFACT_INVALID',
        attempts,
        finalRuntimeVerification,
        finalGate,
        reason: repair.reason,
      };
    }

    finalRuntimeVerification = runVerification({
      rawTask: input.rawTask,
      projectRoot: input.projectRoot,
      toolCallLog: input.toolCallLog,
      babelRoot: input.babelRoot,
    });
    finalGate = evaluateGate({
      rawTask: input.rawTask,
      projectRoot: input.projectRoot,
      toolCallLog: input.toolCallLog,
      runtimeVerification: finalRuntimeVerification,
    });
    attempts.push({
      repair,
      runtimeVerification: finalRuntimeVerification,
      runnableArtifactGate: finalGate,
    });

    if (finalRuntimeVerification.status === 'TOOL_UNAVAILABLE') {
      return {
        status: 'EXECUTION_HALTED_VERIFICATION_TOOL_UNAVAILABLE',
        attempts,
        finalRuntimeVerification,
        finalGate,
        reason: finalRuntimeVerification.reason,
      };
    }

    if (finalRuntimeVerification.status === 'PASS' && finalGate.status === 'PASS') {
      return {
        status: 'REPAIRED_AND_COMPLETE',
        attempts,
        finalRuntimeVerification,
        finalGate,
        reason:
          'Godot artifact repair passed fresh runtime verification and the Runnable Artifact Gate.',
      };
    }
  }

  return {
    status: 'EXECUTION_HALTED_REPAIR_BUDGET_EXCEEDED',
    attempts,
    finalRuntimeVerification,
    finalGate,
    reason: `Godot artifact repair remained invalid after ${maxRepairAttempts} attempt(s).`,
  };
}
