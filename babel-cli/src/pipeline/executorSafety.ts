import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  getBenchmarkRuntimeCommandUsability,
  getCachedBenchmarkContainerRuntimeInventory,
  shouldUseDockerSandbox,
} from '../config/benchmarkContainer.js';
import {
  DEFAULT_EXECUTION_PROFILE,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { formatToolCapabilityResolutionForFeedback } from '../config/toolCapabilities.js';
import { getAllowedShellCommands, validateExecutorShellCommand } from '../sandbox.js';
import type { OrchestratorManifest, QaVerdictReject, SwePlan } from '../schemas/agentContracts.js';
import { collectBenchmarkRiskPlanViolations } from '../stages/benchmarkVerification.js';
import { isWithinProjectRootPath } from '../stages/executorHelpers.js';
import {
  isGradleProvisioningStep,
  isJavaProvisioningStep,
  usesGradleLikeCommand,
  type CommandRuntimeStatus,
  type JavaRuntimeStatus,
} from '../stages/runtimePreflight.js';
import {
  getRequestedTargetContract,
  isAndroidUtilityFileRequest,
  normalizePathForComparison,
} from '../stages/taskShape.js';
import { isAndroidSourceOnlyWorkspace } from './androidWorkspace.js';
import { resolveShellCommandCapability } from './benchmarkRuntime.js';
import {
  getBenchmarkDependencyInstallPlanReject,
  getBenchmarkProtectedWriteReason,
  isExternalBenchmarkTask,
  isInvalidGitBundleArchiveCommand,
  normalizeShellCommandForComparison,
  shouldEnforceBoundedPlanActivationContract,
} from './benchmarkTasks.js';
import { inferProjectRoot } from './manifestContext.js';
import { BABEL_ROOT } from './paths.js';

function getToolCapabilityBlockedFixHint(
  resolution: ReturnType<typeof resolveShellCommandCapability>,
): string {
  if (
    resolution.capabilityId === 'run.pytest_test_outputs' &&
    resolution.missingRequirements.includes('pytest')
  ) {
    return 'Pytest is missing, so do not plan test_outputs.py with plain Python, pytest, or package installation. Remove that verifier step and use an available source-only/custom verification route such as filter.py plus a separate out.html postcondition check, or halt with the missing verification capability.';
  }

  return 'Use the benchmark runtime inventory and executor allowlist to choose an available capability implementation, choose a source-only route, or halt with the missing capability instead of retrying equivalent syntax.';
}

function getExecutorSafetyProposedFixStrategy(
  failures: readonly QaVerdictReject['failures'][number][],
): string {
  if (failures.some((failure) => /BENCHMARK_CUSTOM_VERIFIER_REQUIRED/.test(failure.condition))) {
    return 'Regenerate the plan with a real custom executable verifier step that exits nonzero unless filtered out.html satisfies the alert/bypass postcondition; do not substitute manual browser instructions or file_read inspection.';
  }

  if (failures.some((failure) => /BENCHMARK_STRIPPED_PAYLOAD_ASSUMPTION/.test(failure.condition))) {
    return 'Regenerate the plan without pre-committing to script tags, on* event handlers, or entity-encoded JavaScript; choose the payload family only from filter.py source evidence.';
  }

  if (failures.some((failure) => /BENCHMARK_SOURCE_INSPECTION_REQUIRED/.test(failure.condition))) {
    return 'Regenerate the plan so it reads filter.py before choosing or writing the out.html payload.';
  }

  const pytestMissingFailure = failures.find(
    (failure) =>
      /run\.pytest_test_outputs|test_outputs\.py/i.test(failure.condition) &&
      /pytest/i.test(failure.condition),
  );
  if (pytestMissingFailure) {
    return 'Regenerate the plan without any test_outputs.py verifier step because pytest is unavailable; use an available custom/source-level check or halt with the missing verification capability.';
  }

  return (
    failures[0]?.fix_hint ??
    'Regenerate the plan so every executor-facing target is concrete, in-root, and compatible with the active execution profile.'
  );
}

function extractWindowsAbsolutePaths(value: string): string[] {
  const quotedMatches = Array.from(
    value.matchAll(/["']([A-Za-z]:\\[^"']+)["']/g),
    (match) => match[1] ?? '',
  );
  const bareMatches = Array.from(
    value.matchAll(/\b([A-Za-z]:\\[^\s"'|;&]+)/g),
    (match) => match[1] ?? '',
  );
  return [...new Set([...quotedMatches, ...bareMatches].filter((match) => match.length > 0))];
}

function collectBoundedContractViolations(
  swePlan: SwePlan,
  rawTask: string,
): QaVerdictReject | null {
  if (isExternalBenchmarkTask(rawTask)) {
    return null;
  }

  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const fileWriteTargets = swePlan.minimal_action_set
    .filter((step) => step.tool === 'file_write')
    .map((step) => ({
      step: step.step,
      target: normalizePathForComparison(String(step.target ?? '')),
    }))
    .filter((entry) => entry.target.length > 0);
  const fileWriteSet = new Set(fileWriteTargets.map((entry) => entry.target.toLowerCase()));
  const requestedTargetSet = new Set(
    contract.requestedTargets.map((target) => target.toLowerCase()),
  );

  for (const requestedTarget of contract.requestedTargets) {
    if (!fileWriteSet.has(requestedTarget.toLowerCase())) {
      failures.push({
        tag: 'INCOMPLETE_SUBMISSION',
        condition: `[BOUNDED_CONTRACT] Plan does not include an exact file_write step for requested output: ${requestedTarget}`,
        confidence: 5,
        fix_hint: 'Add an exact file_write step for every requested output path.',
      });
    }
  }

  for (const fileWriteTarget of fileWriteTargets) {
    if (!requestedTargetSet.has(fileWriteTarget.target.toLowerCase())) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[BOUNDED_CONTRACT] Step ${fileWriteTarget.step} writes an unrequested file for this bounded task: ${fileWriteTarget.target}`,
        confidence: 5,
        fix_hint:
          'Keep file_write targets inside the explicit requested target set for bounded tasks.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy:
      'Regenerate the plan so bounded tasks preserve the exact requested output path set with one file_write per requested file.',
  };
}

/**
 * Final pre-executor assertion for bounded tasks.
 *
 * `collectBoundedContractViolations` runs inside the SWE↔QA retry loop and causes
 * replanning when targets drift. This function runs once after QA PASS as a hard
 * activation gate — it prevents the executor from starting if a bounded plan somehow
 * reached approval with a mismatched write-target set.
 *
 * Returns a human-readable rejection reason, or null if the plan is clean.
 */
export function assertBoundedPlanActivationContract(
  approvedPlan: SwePlan,
  rawTask: string,
): string | null {
  if (!shouldEnforceBoundedPlanActivationContract(rawTask)) {
    return null;
  }

  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0) {
    return null;
  }

  const fileWriteTargets = approvedPlan.minimal_action_set
    .filter((step) => step.tool === 'file_write')
    .map((step) => normalizePathForComparison(String(step.target ?? '')))
    .filter((target) => target.length > 0);
  const fileWriteSet = new Set(fileWriteTargets.map((t) => t.toLowerCase()));
  const requestedTargetSet = new Set(contract.requestedTargets.map((t) => t.toLowerCase()));

  const missing = contract.requestedTargets.filter((t) => !fileWriteSet.has(t.toLowerCase()));
  const extra = fileWriteTargets.filter((t) => !requestedTargetSet.has(t.toLowerCase()));

  if (missing.length === 0 && extra.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing required write targets: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    parts.push(`unrequested write targets: ${extra.join(', ')}`);
  }
  return `[BOUNDED_CONTRACT_ACTIVATION_GATE] Approved plan failed pre-executor target check — ${parts.join('; ')}. Requested set: ${contract.requestedTargets.join(', ')}.`;
}

export function collectExecutorSafetyViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  rawTask: string,
  executionProfileName: ExecutionProfileName = DEFAULT_EXECUTION_PROFILE,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const boundedContractReject = collectBoundedContractViolations(swePlan, rawTask);
  if (boundedContractReject) {
    return boundedContractReject;
  }

  const manyFileAggregationReject = collectManyFileAggregationViolations(swePlan, rawTask);
  if (manyFileAggregationReject) {
    return manyFileAggregationReject;
  }

  const failures: QaVerdictReject['failures'] = [];
  const shellWrapperRe = /\b(cmd(\.exe)?\s*\/c|powershell(\.exe)?\b|pwsh\b|bash\b|sh\b)\b/i;
  const shellChainingRe = /&&|\|\||[;|]/;
  const cdWrapperRe = /\bcd\s+[A-Za-z]:\\/i;
  const globTargetRe = /[*?\[\]]/;
  const anglePlaceholderRe = /<[A-Za-z][^>\s]*>/;
  const benchmarkShellSyntaxAllowed = shouldUseDockerSandbox(executionProfileName);
  const benchmarkRuntimeInventory = benchmarkShellSyntaxAllowed
    ? getCachedBenchmarkContainerRuntimeInventory(
        process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '',
      )
    : null;
  const allowedShellCommands = getAllowedShellCommands(executionProfileName);
  if (/\bbreak-filter-js-from-html\b/i.test(rawTask)) {
    const readsFilterSource = swePlan.minimal_action_set.some(
      (step) =>
        step.tool === 'file_read' &&
        normalizePathForComparison(String(step.target ?? '')).toLowerCase() === 'filter.py',
    );
    if (!readsFilterSource) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_SOURCE_INSPECTION_REQUIRED] break-filter-js-from-html plans must read filter.py before choosing an out.html payload; otherwise the executor guesses at sanitizer behavior and can burn turns on stripped event-handler payloads.',
        confidence: 5,
        fix_hint:
          'Start with file_read filter.py, then write out.html based on the observed parser/removal logic and verify by running filter.py plus a custom postcondition check.',
      });
    }

    const planText = JSON.stringify(swePlan).toLowerCase();
    if (
      /\b(?:event handlers?|onerror|onclick|onload|onmouseover|script tags?|<script|encoded alert|encoded javascript|html entity encoding|obfuscated javascript)\b/i.test(
        planText,
      )
    ) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_STRIPPED_PAYLOAD_ASSUMPTION] break-filter-js-from-html plan assumes stripped payload families such as script tags, on* event handlers, or entity-encoded JavaScript will survive. The visible sanitizer source must drive payload choice; do not pre-commit to families the filter is likely to remove.',
        confidence: 5,
        fix_hint:
          'After reading filter.py, choose a payload family based on what the sanitizer actually leaves intact. Avoid script tags, on* event handlers, and pure entity-encoded JavaScript assumptions unless the source proves they survive.',
      });
    }

    const hasCustomVerifierStep = swePlan.minimal_action_set.some((step) => {
      if (step.tool !== 'shell_exec' && step.tool !== 'test_run') {
        return false;
      }
      const command = String(step.target ?? '').toLowerCase();
      if (
        /(?:manual verification|manual browser|open in browser|confirm alert|print\(['"`]?manual)/.test(
          command,
        )
      ) {
        return false;
      }
      return (
        !/\b(?:test_outputs\.py|filter\.py)\b/.test(command) &&
        /(?:verify|check|assert|bypass|alert|postcondition)/.test(command)
      );
    });
    if (!hasCustomVerifierStep) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_CUSTOM_VERIFIER_REQUIRED] break-filter-js-from-html plans must include a custom executable verifier when pytest/test_outputs.py is unavailable. Running filter.py and then file_reading out.html is not enough to prove browser alert behavior.',
        confidence: 5,
        fix_hint:
          'Add a separate helper or inline shell_exec/test_run step that checks the filtered out.html postcondition, then complete only after that verifier exits 0.',
      });
    }
  }
  if (benchmarkShellSyntaxAllowed && /\bmerge-diff-arc-agi-task\b/i.test(rawTask)) {
    const hasGitNativeStep = swePlan.minimal_action_set.some(
      (step) =>
        (step.tool === 'shell_exec' || step.tool === 'test_run') &&
        /\bgit\s+(?:bundle|init|fetch|checkout|switch|merge|status|branch)\b/i.test(
          String(step.target ?? ''),
        ),
    );
    const hasSourceOnlyRepoWrite = swePlan.minimal_action_set.some(
      (step) =>
        step.tool === 'file_write' &&
        /(?:^|[\\/])repo[\\/](?:algo\.py|\.gitkeep)$/i.test(
          normalizePathForComparison(String(step.target ?? '')),
        ),
    );
    if (!hasGitNativeStep && hasSourceOnlyRepoWrite) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_REQUIRED_CAPABILITY_MISSING] merge-diff-arc-agi-task requires Git-native bundle checkout and merge steps; the plan omits Git and would substitute source-only placeholder writes.',
        confidence: 5,
        fix_hint:
          'Do not satisfy merge-diff by writing repo/algo.py or .gitkeep directly. If git is unavailable in the benchmark runtime inventory, halt with missing required runtime capability or use an explicitly approved benchmark Git provisioning route.',
      });
    }
  }

  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    if (anglePlaceholderRe.test(target)) {
      failures.push({
        tag: 'INCOMPLETE_SUBMISSION',
        condition: `[EXECUTOR_SAFETY] Step ${step.step} contains an unresolved placeholder target: ${target}`,
        confidence: 5,
        fix_hint:
          'Replace placeholders with a concrete in-project path or command before sending the plan to executor.',
      });
      continue;
    }

    if (step.tool === 'directory_list' || step.tool === 'file_read' || step.tool === 'file_write') {
      if ((step.tool === 'file_read' || step.tool === 'file_write') && globTargetRe.test(target)) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} uses a glob target unsupported by ${step.tool}: ${target}`,
          confidence: 5,
          fix_hint:
            'Use directory_list first, then concrete file_read/file_write targets. Do not pass wildcards to file tools.',
        });
        continue;
      }

      if (step.tool === 'file_write') {
        const benchmarkProtectedWriteReason = getBenchmarkProtectedWriteReason(rawTask, target);
        if (benchmarkProtectedWriteReason) {
          failures.push({
            tag: 'SFDIPOT-P',
            condition: `[EXECUTOR_SAFETY] Step ${step.step} writes a protected benchmark fixture: ${benchmarkProtectedWriteReason}`,
            confidence: 5,
            fix_hint:
              'Do not modify benchmark verifier/input fixtures. Patch the requested output artifact or create a new helper script with a different name.',
          });
          continue;
        }
      }

      const resolvedTarget = /^[A-Za-z]:[\\/]/.test(target)
        ? resolve(target)
        : resolve(projectRoot, target);

      if (!isWithinProjectRootPath(projectRoot, resolvedTarget)) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} targets a path outside target_project_path: ${target}`,
          confidence: 5,
          fix_hint:
            'Use only project-root-relative paths or mirrored in-root references for executor-accessible files.',
        });
      }
      continue;
    }

    if (step.tool === 'shell_exec' || step.tool === 'test_run') {
      if (
        shellWrapperRe.test(target) ||
        cdWrapperRe.test(target) ||
        (shellChainingRe.test(target) && !benchmarkShellSyntaxAllowed)
      ) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} uses shell-wrapped or chained command syntax that violates executor contract: ${target}`,
          confidence: 5,
          fix_hint: benchmarkShellSyntaxAllowed
            ? 'Avoid explicit shell wrappers and cd commands; POSIX pipes/redirection may run directly inside the benchmark container.'
            : 'Emit the executable command only and rely on working_directory instead of shell wrappers or chaining.',
        });
      } else {
        const benchmarkInstallPlanReject = benchmarkShellSyntaxAllowed
          ? getBenchmarkDependencyInstallPlanReject(rawTask, target)
          : null;
        const gitBundleArchiveReject =
          benchmarkShellSyntaxAllowed && isInvalidGitBundleArchiveCommand(rawTask, target);
        const shellCompatibilityIssue =
          benchmarkInstallPlanReject || gitBundleArchiveReject
            ? null
            : validateExecutorShellCommand(
                target,
                process.platform,
                executionProfileName,
              );
        if (benchmarkInstallPlanReject) {
          failures.push({
            tag: 'SFDIPOT-P',
            condition: `[EXECUTOR_SAFETY] Step ${step.step} uses a blocked benchmark dependency install command: ${benchmarkInstallPlanReject}`,
            confidence: 5,
            fix_hint:
              'Replace package installation with a source-only/file_write route or an existing runtime command from the benchmark inventory.',
          });
        } else if (gitBundleArchiveReject) {
          failures.push({
            tag: 'SFDIPOT-P',
            condition: `[EXECUTOR_SAFETY] Step ${step.step} treats a Git bundle as an archive: ${target}`,
            confidence: 5,
            fix_hint:
              'Git .bundle files are not tar/gzip archives. Use Git-native bundle commands if git is usable, or halt with missing required runtime capability.',
          });
        } else {
          const capabilityResolution = resolveShellCommandCapability(
            target,
            rawTask,
            executionProfileName,
            benchmarkRuntimeInventory,
          );
          const capabilityFeedback =
            formatToolCapabilityResolutionForFeedback(capabilityResolution);
          if (
            capabilityResolution.status === 'suggest_replacement' &&
            normalizeShellCommandForComparison(capabilityResolution.replacementCommand ?? '') !==
              normalizeShellCommandForComparison(target)
          ) {
            failures.push({
              tag: 'SFDIPOT-P',
              condition:
                `[EXECUTOR_SAFETY] Step ${step.step} uses a generic command where a safer capability implementation is available: ` +
                capabilityFeedback,
              confidence: 5,
              fix_hint: capabilityResolution.replacementCommand
                ? `Replace the command with "${capabilityResolution.replacementCommand}".`
                : 'Replace the command with the capability-specific implementation.',
            });
          } else if (
            capabilityResolution.status === 'blocked_missing_requirement' ||
            capabilityResolution.status === 'blocked_no_allowed_implementation'
          ) {
            const fixHint = getToolCapabilityBlockedFixHint(capabilityResolution);
            failures.push({
              tag: 'SFDIPOT-P',
              condition:
                `[EXECUTOR_SAFETY] Step ${step.step} cannot use the requested command capability: ` +
                capabilityFeedback,
              confidence: 5,
              fix_hint: fixHint,
            });
          } else if (shellCompatibilityIssue) {
            failures.push({
              tag: 'SFDIPOT-P',
              condition:
                `[EXECUTOR_SAFETY] Step ${step.step} uses a shell command that violates executor compatibility rules: ` +
                `${shellCompatibilityIssue.message}`,
              confidence: 5,
              fix_hint:
                shellCompatibilityIssue.command_base === 'mkdir'
                  ? 'Remove the mkdir step and write the target file directly; file_write creates parent directories automatically.'
                  : 'Replace the command with an executor-supported command base and platform-compatible syntax.',
            });
          } else if (benchmarkRuntimeInventory) {
            const usability = getBenchmarkRuntimeCommandUsability(
              benchmarkRuntimeInventory,
              allowedShellCommands,
              target,
            );
            if (usability.status === 'missing' || usability.status === 'not_executor_allowed') {
              failures.push({
                tag: 'SFDIPOT-P',
                condition:
                  `[EXECUTOR_SAFETY] Step ${step.step} uses a benchmark runtime command that is not usable: ` +
                  `${usability.message}`,
                confidence: 5,
                fix_hint:
                  'Use the benchmark runtime inventory from the planning context and choose an available executor-allowed command or a source-only/file_write route.',
              });
            }
          }
        }
      }

      const outOfRootPaths = extractWindowsAbsolutePaths(target).filter(
        (candidatePath) => !isWithinProjectRootPath(projectRoot, candidatePath),
      );
      if (outOfRootPaths.length > 0) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} references out-of-root path(s) in command target: ${outOfRootPaths.join(', ')}`,
          confidence: 5,
          fix_hint:
            'Use only paths rooted under target_project_path or stage mirrored references inside the project root first.',
        });
      }
    }
  }

  failures.push(...collectBenchmarkRiskPlanViolations(swePlan, rawTask));

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: getExecutorSafetyProposedFixStrategy(failures),
  };
}

function collectManyFileAggregationViolations(
  swePlan: SwePlan,
  rawTask: string,
): QaVerdictReject | null {
  const manyFileAggregationTask =
    /\b(all|multiple|every)\s+(?:log\s+)?files\b/i.test(rawTask) || /\ball\s+logs\b/i.test(rawTask);
  const aggregationOutputTask =
    /\b(count|aggregate|summari[sz]e|analy[sz]e)\b/i.test(rawTask) &&
    /\b(csv|json|summary|report)\b/i.test(rawTask);
  if (!manyFileAggregationTask || !aggregationOutputTask) {
    return null;
  }

  const hasHelperExecution = swePlan.minimal_action_set.some(
    (step) => step.tool === 'shell_exec' || step.tool === 'test_run',
  );
  const hasHelperWrite = swePlan.minimal_action_set.some((step) => {
    if (step.tool !== 'file_write') return false;
    const target = String(step.target ?? '').toLowerCase();
    return /\.(py|js|mjs|ts|sh|ps1|rb)$/.test(target);
  });
  const finalOutputWrites = swePlan.minimal_action_set.filter((step) => {
    if (step.tool !== 'file_write') return false;
    const target = String(step.target ?? '').toLowerCase();
    return /\.(csv|json|txt|tsv)$/.test(target);
  });

  const failures: QaVerdictReject['failures'] = [];
  if (!hasHelperWrite || !hasHelperExecution) {
    failures.push({
      tag: 'SFDIPOT-P',
      condition:
        '[MANY_FILE_AGGREGATION] Plan samples large input sets instead of writing and running a deterministic helper program.',
      confidence: 5,
      fix_hint:
        'For many-file aggregation tasks, write a small helper script in the project root, run it with an allowed interpreter such as python/node, and let that script produce the requested output file.',
    });
  }
  if (finalOutputWrites.length > 0 && !hasHelperExecution) {
    failures.push({
      tag: 'SFDIPOT-O',
      condition:
        '[MANY_FILE_AGGREGATION] Plan writes the final output directly before executing a complete aggregation over all input files.',
      confidence: 5,
      fix_hint:
        'Do not hand-write aggregate counts from sampled files. Generate the output from a helper program that iterates every concrete file in the input directory.',
    });
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy:
      'Regenerate the plan around deterministic many-file aggregation: directory_list, file_write helper script, shell_exec/test_run helper, then inspect or verify the produced output.',
  };
}

export function collectRuntimePrerequisiteViolations(
  swePlan: SwePlan,
  javaRuntimeStatus: JavaRuntimeStatus,
  gradleRuntimeStatus: CommandRuntimeStatus,
): QaVerdictReject | null {
  const failures: QaVerdictReject['failures'] = [];

  const firstGradleLikeStep = swePlan.minimal_action_set.find(
    (step) =>
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      usesGradleLikeCommand(String(step.target ?? '')),
  );

  if (!firstGradleLikeStep) {
    return null;
  }

  const priorSteps = swePlan.minimal_action_set.filter(
    (step) => step.step < firstGradleLikeStep.step,
  );
  const hasJavaProvisioning = priorSteps.some((step) => isJavaProvisioningStep(step));
  const hasGradleProvisioning = priorSteps.some((step) => isGradleProvisioningStep(step));

  if (!javaRuntimeStatus.available && !hasJavaProvisioning) {
    failures.push({
      tag: 'SFDIPOT-P',
      condition: `[RUNTIME_PREFLIGHT] Step ${firstGradleLikeStep.step} invokes Gradle (${firstGradleLikeStep.target}) but Java is currently unavailable in the executor environment.`,
      confidence: 5,
      fix_hint:
        'Add an earlier step that installs or configures Java/JDK and JAVA_HOME before the first gradle/gradlew command.',
    });
  }

  const usesGlobalGradle = swePlan.minimal_action_set.some(
    (step) =>
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      /\bgradle\b/i.test(String(step.target ?? '')) &&
      !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')) &&
      !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')),
  );

  if (usesGlobalGradle && !gradleRuntimeStatus.available && !hasGradleProvisioning) {
    const firstGlobalGradleStep = swePlan.minimal_action_set.find(
      (step) =>
        (step.tool === 'shell_exec' || step.tool === 'test_run') &&
        /\bgradle\b/i.test(String(step.target ?? '')) &&
        !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')) &&
        !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')),
    );
    if (firstGlobalGradleStep) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[RUNTIME_PREFLIGHT] Step ${firstGlobalGradleStep.step} invokes global Gradle (${firstGlobalGradleStep.target}) but gradle is not available on PATH in the executor environment.`,
        confidence: 5,
        fix_hint:
          'Install or configure Gradle before the first global `gradle` command, or switch to a wrapper-based path that does not assume global Gradle already exists.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy:
      'Regenerate the plan so runtime prerequisites are satisfied first: bootstrap the missing Java/Gradle dependency, then run Gradle verification or builds.',
  };
}

export function collectGradleBootstrapSequencingViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  gradleRuntimeStatus: CommandRuntimeStatus,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const wrapperJarExists = existsSync(wrapperJarPath);
  if (gradleRuntimeStatus.available || wrapperJarExists) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const provisioningIndex = swePlan.minimal_action_set.findIndex((step) =>
    isGradleProvisioningStep(step),
  );
  const provisioningStepNumber =
    provisioningIndex >= 0 ? (swePlan.minimal_action_set[provisioningIndex]?.step ?? null) : null;

  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    if (String(step.tool ?? '').trim() !== 'file_read') {
      continue;
    }

    const normalizedTarget = target.replace(/\//g, '\\').toLowerCase();
    const isMirroredGradleRead =
      ((step.tool === 'file_read' || step.tool === 'directory_list') &&
        normalizedTarget.includes('\\reference-montecarlo-ledger\\') &&
        normalizedTarget.includes('gradle')) ||
      ((step.tool === 'file_read' || step.tool === 'directory_list') &&
        normalizedTarget.includes('\\reference-montecarlo-ledger\\build.gradle.kts')) ||
      ((step.tool === 'file_read' || step.tool === 'directory_list') &&
        normalizedTarget.includes('\\reference-montecarlo-ledger\\settings.gradle.kts')) ||
      ((step.tool === 'file_read' || step.tool === 'directory_list') &&
        normalizedTarget.includes('\\reference-montecarlo-ledger\\app\\build.gradle.kts'));

    if (isMirroredGradleRead) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[GRADLE_BOOTSTRAP] Step ${step.step} probes mirrored Gradle files during bootstrap even though global gradle is absent and gradle-wrapper.jar is missing: ${target}`,
        confidence: 5,
        fix_hint:
          'Provision Gradle first, then generate/verify gradle-wrapper.jar. Do not read mirrored Gradle files during bootstrap unless they are already confirmed to exist.',
      });
    }

    const usesGlobalGradle =
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      /\bgradle\b/i.test(target) &&
      !/\b(winget|choco|scoop)\b/i.test(target) &&
      !/\bgradlew(?:\.bat)?\b/i.test(target);
    if (
      usesGlobalGradle &&
      (provisioningStepNumber === null || step.step < provisioningStepNumber)
    ) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[GRADLE_BOOTSTRAP] Step ${step.step} uses global Gradle before any concrete provisioning step while gradle is absent and gradle-wrapper.jar is missing: ${target}`,
        confidence: 5,
        fix_hint:
          'Make the first global-Gradle-related step a concrete provisioning step such as winget install Gradle.Gradle, then verify gradle, then run gradle wrapper.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy:
      'Regenerate the Gradle bootstrap portion so it provisions Gradle first, avoids mirrored Gradle file reads during bootstrap, and only then generates/verifies gradle-wrapper.jar.',
  };
}

export function collectAndroidVerificationCoverageViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  rawTask = '',
): QaVerdictReject | null {
  const pipelineMode = String(manifest.analysis?.pipeline_mode ?? '').toLowerCase();
  const taskCategory = String(manifest.analysis?.task_category ?? '').toLowerCase();
  const isAutonomousAndroidTask =
    pipelineMode === 'deep' &&
    (manifest.instruction_stack?.domain_id === 'domain_android_kotlin' ||
      taskCategory === 'mobile');

  if (!isAutonomousAndroidTask) {
    return null;
  }

  if (isAndroidSourceOnlyWorkspace(inferProjectRoot(manifest))) {
    return null;
  }

  const shellSteps = swePlan.minimal_action_set.filter(
    (step) => step.tool === 'shell_exec' || step.tool === 'test_run',
  );
  const hasAssembleDebug = shellSteps.some((step) =>
    /\bgradlew(?:\.bat)?\b.*\bassembleDebug\b/i.test(String(step.target ?? '')),
  );
  const hasGradleTest = shellSteps.some((step) =>
    /\bgradlew(?:\.bat)?\b.*\btest\b/i.test(String(step.target ?? '')),
  );
  const firstVerificationStep =
    shellSteps.length > 0
      ? Math.min(...shellSteps.map((step) => step.step))
      : Number.POSITIVE_INFINITY;
  const taskShapeProfile = String(manifest.resolution_policy?.task_shape_profile ?? 'full');
  if (
    taskShapeProfile === 'android_utility_file' ||
    isAndroidUtilityFileRequest(rawTask, inferProjectRoot(manifest)).match
  ) {
    return null;
  }

  const earlyVerificationLimit =
    taskShapeProfile === 'android_warning_cleanup'
      ? 10
      : taskShapeProfile === 'android_ui_improvement'
        ? 5
        : 8;

  if (hasAssembleDebug && hasGradleTest && firstVerificationStep <= earlyVerificationLimit) {
    return null;
  }

  const missingParts = [
    !hasAssembleDebug ? 'gradlew assembleDebug' : null,
    !hasGradleTest ? 'gradlew test' : null,
  ].filter((part): part is string => part !== null);
  const schedulingNote =
    firstVerificationStep === Number.POSITIVE_INFINITY
      ? 'no verification steps were scheduled'
      : `first verification step is too late (step ${firstVerificationStep})`;

  return {
    verdict: 'REJECT',
    failure_count: 1,
    failures: [
      {
        tag: 'EVIDENCE-GATE',
        condition:
          taskShapeProfile === 'android_warning_cleanup'
            ? `Autonomous Android warning-cleanup plans must verify with both \`gradlew assembleDebug\` and \`gradlew test\` early enough to run; missing: ${missingParts.join(', ')}, ${schedulingNote}.`
            : `Autonomous Android implementation plans must verify with both \`gradlew assembleDebug\` and \`gradlew test\` early enough to run; missing: ${missingParts.join(', ')}, ${schedulingNote}.`,
        confidence: 5,
        fix_hint:
          taskShapeProfile === 'android_warning_cleanup'
            ? 'Add both verification steps to the plan so the autonomous warning-cleanup lane can surface compile and test-only regressions.'
            : 'Add both verification steps to the plan so the autonomous lane can surface compile and test-only regressions.',
      },
    ],
    overall_confidence: 5,
    proposed_fix_strategy:
      taskShapeProfile === 'android_warning_cleanup'
        ? 'Regenerate the autonomous Android warning-cleanup plan so it includes both compile verification and unit-test verification before completion.'
        : 'Regenerate the autonomous Android plan so it includes both compile verification and unit-test verification before completion.',
  };
}

export function collectReferenceSourceShapeViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const referenceRoot = join(projectRoot, 'reference-montecarlo-ledger');
  const externalReferenceRoot = join(BABEL_ROOT, '..', 'Antigavity_Projects', 'MonteCarlo-Ledger');
  const referenceLooksLikePython =
    existsSync(referenceRoot) &&
    (existsSync(join(referenceRoot, 'pyproject.toml')) ||
      existsSync(join(referenceRoot, 'requirements.txt')) ||
      existsSync(join(referenceRoot, 'monte_carlo_ledger')));
  if (!referenceLooksLikePython) {
    return null;
  }

  const collectExistingReferenceFiles = (rootPath: string): string[] => {
    const results: string[] = [];
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const nextPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(nextPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!/\.(py|md|toml|sql|yaml|yml|json)$/i.test(entry.name)) {
          continue;
        }
        results.push(resolve(nextPath).toLowerCase());
      }
    }
    return results;
  };

  const failures: QaVerdictReject['failures'] = [];
  const existingReferenceFiles = new Set(collectExistingReferenceFiles(referenceRoot));
  const referenceRootPath = resolve(referenceRoot).toLowerCase();
  let seenReferenceReadme = false;
  let seenReferencePyproject = false;
  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    const normalizedTarget = target.replace(/\//g, '\\').toLowerCase();
    const resolvedTarget = /^[A-Za-z]:[\\/]/.test(target)
      ? resolve(target)
      : resolve(projectRoot, target);
    const normalizedResolvedTarget = resolvedTarget.toLowerCase();
    const probesAndroidMirrorInsideReference =
      normalizedTarget.includes('\\reference-montecarlo-ledger\\app\\src\\main\\') ||
      normalizedTarget.includes('\\reference-montecarlo-ledger\\build.gradle.kts') ||
      normalizedTarget.includes('\\reference-montecarlo-ledger\\settings.gradle.kts') ||
      normalizedTarget.includes('\\reference-montecarlo-ledger\\app\\build.gradle.kts');

    if (probesAndroidMirrorInsideReference) {
      failures.push({
        tag: 'EVIDENCE-GATE',
        condition: `[SOURCE_SHAPE] Step ${step.step} assumes Android/Gradle mirror files inside reference-montecarlo-ledger even though the grounded reference source is a Python repo: ${target}`,
        confidence: 5,
        fix_hint:
          'Treat reference-montecarlo-ledger as a Python source repo. Read actual files such as README.md, pyproject.toml, monte_carlo_ledger/*.py, and docs/** before mapping them into Android targets.',
      });
      continue;
    }

    if (normalizedResolvedTarget.startsWith(resolve(externalReferenceRoot).toLowerCase())) {
      failures.push({
        tag: 'EVIDENCE-GATE',
        condition: `[SOURCE_PATH_PREFERENCE] Step ${step.step} reads the external MonteCarlo-Ledger repo even though a mirrored reference-montecarlo-ledger copy exists inside the target project: ${target}`,
        confidence: 5,
        fix_hint:
          'Use the mirrored reference-montecarlo-ledger path inside the target project for all source reads when that mirror exists.',
      });
      continue;
    }

    if (normalizedResolvedTarget.startsWith(resolve(referenceRoot).toLowerCase())) {
      const isReferenceReadStep = step.tool === 'file_read';
      if (isReferenceReadStep) {
        const isReadme =
          normalizedResolvedTarget === join(referenceRootPath, 'readme.md').toLowerCase();
        const isPyproject =
          normalizedResolvedTarget === join(referenceRootPath, 'pyproject.toml').toLowerCase();
        const isRootBootstrapRead = isReadme || isPyproject;
        const isModuleRead = normalizedResolvedTarget
            .replace(/\//g, '\\')
            .includes('\\reference-montecarlo-ledger\\monte_carlo_ledger\\');
        const basename = normalizedResolvedTarget.split('\\').pop() ?? '';
        if (
          swePlan.plan_type !== 'IMPLEMENTATION_PLAN' &&
          isModuleRead &&
          !existingReferenceFiles.has(normalizedResolvedTarget)
        ) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[SOURCE_INVENTORY_GUESS] Step ${step.step} guesses a non-inventory module basename under the reference repo: ${basename}`,
            confidence: 5,
            fix_hint:
              'Use the exact filenames listed in the Reference source inventories block. Do not guess module names like engine.py, models.py, core_engine.py, or data_models.py.',
          });
          continue;
        }
        if (
          swePlan.plan_type !== 'IMPLEMENTATION_PLAN' &&
          isModuleRead &&
          !(seenReferenceReadme && seenReferencePyproject)
        ) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[REFERENCE_FILE_READ_DISCIPLINE] Step ${step.step} reads a reference module before grounding on README.md and pyproject.toml: ${target}`,
            confidence: 5,
            fix_hint:
              'Read README.md and pyproject.toml first, then read only the exact grounded module files listed in the inventory.',
          });
          continue;
        }
        if (isReadme) {
          seenReferenceReadme = true;
        }
        if (isPyproject) {
          seenReferencePyproject = true;
        }
        if (!isRootBootstrapRead && !existingReferenceFiles.has(normalizedResolvedTarget)) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[SOURCE_INVENTORY_MISMATCH] Step ${step.step} reads a non-existent file inside reference-montecarlo-ledger instead of one of the grounded inventory files: ${target}`,
            confidence: 5,
            fix_hint:
              'Use the exact filenames listed in the Reference source inventories block. Do not guess alternate module names inside the mirrored Python repo.',
          });
        }
        continue;
      }

      if (step.tool === 'directory_list') {
        if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isDirectory()) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[SOURCE_INVENTORY_MISMATCH] Step ${step.step} lists a non-existent reference directory instead of a grounded directory inside reference-montecarlo-ledger: ${target}`,
            confidence: 5,
            fix_hint:
              'Use only real directories under the mirrored reference repo for directory_list steps.',
          });
        }
        continue;
      }

      if (step.tool === 'file_read' && !existingReferenceFiles.has(normalizedResolvedTarget)) {
        failures.push({
          tag: 'EVIDENCE-GATE',
          condition: `[SOURCE_INVENTORY_MISMATCH] Step ${step.step} reads a non-existent file inside reference-montecarlo-ledger instead of one of the grounded inventory files: ${target}`,
          confidence: 5,
          fix_hint:
            'Use the exact filenames listed in the Reference source inventories block. Do not guess alternate module names inside the mirrored Python repo.',
        });
      }
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy:
      'Regenerate the plan against the actual reference source shape. Do not infer Android package or Gradle files inside a non-Android reference repo.',
  };
}
