import {
  DEFAULT_EXECUTION_PROFILE,
  buildExecutionProfilePromptLines,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { shouldUseBenchmarkContainerExecution } from '../config/benchmarkContainer.js';
import { buildToolCapabilityPromptLines } from '../config/toolCapabilities.js';
import { getAllowedShellCommands } from '../sandbox.js';
import type { SwePlan } from '../schemas/agentContracts.js';
import {
  type AndroidSdkStatus,
  type CommandRuntimeStatus,
  type JavaRuntimeStatus,
} from '../stages/runtimePreflight.js';
import { buildBenchmarkVerificationPromptLines } from '../stages/benchmarkVerification.js';
import { getBoundedTaskQaLines } from '../stages/taskShape.js';
import {
  getBenchmarkRuntimeInventoryLines,
  shouldApplyHostWindowsExecutorNotes,
} from './benchmarkRuntime.js';

export function buildQaTask(
  swePlan: SwePlan,
  javaRuntimeStatus: JavaRuntimeStatus,
  gradleRuntimeStatus: CommandRuntimeStatus,
  androidSdkStatus: AndroidSdkStatus,
  rawTask: string,
  deterministicGradleBootstrapLaneActive = false,
  executionProfileName: ExecutionProfileName = DEFAULT_EXECUTION_PROFILE,
): string {
  const allowedShellCommands = getAllowedShellCommands(executionProfileName);
  const boundedQaLines = getBoundedTaskQaLines(rawTask);
  const executionProfileLines = buildExecutionProfilePromptLines(executionProfileName, 'qa');
  const benchmarkRuntimeInventoryLines = getBenchmarkRuntimeInventoryLines(executionProfileName);
  const toolCapabilityLines = buildToolCapabilityPromptLines(executionProfileName);
  const benchmarkVerificationLines = buildBenchmarkVerificationPromptLines(rawTask);
  const benchmarkShellSyntaxAllowed = shouldUseBenchmarkContainerExecution(
    executionProfileName,
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'],
  );

  return [
    'Review the SWE Plan below and produce a QA verdict as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    '--- FIELD MAPPING (JSON format is the approved submission format) ---',
    'The plan is submitted in machine-readable JSON. Map fields as follows:',
    '  task_summary          → OBJECTIVE',
    '  known_facts           → KNOWN FACTS',
    '  assumptions           → ASSUMPTIONS',
    '  risks[]               → RISKS',
    '  minimal_action_set[]  → MINIMAL ACTION SET',
    '    each step.verification → VERIFICATION METHOD for that step',
    '  root_cause            → ROOT CAUSE',
    '  out_of_scope[]        → scope boundaries',
    'Do NOT use INCOMPLETE_SUBMISSION for missing text sections; the JSON fields above',
    'are the valid submission format. Only use INCOMPLETE_SUBMISSION if a required JSON',
    'field is missing entirely (e.g., minimal_action_set is empty or absent).',
    '',
    '--- EVIDENCE-GATE CLARIFICATION ---',
    'EVIDENCE-GATE requires file visibility ONLY when modifying an EXISTING file.',
    'Do NOT raise EVIDENCE-GATE for steps that CREATE a new file (the file does not exist',
    'yet — there is no current content to inspect). A file_write step with a target path',
    'that the plan is creating from scratch is NOT an EVIDENCE-GATE violation.',
    '',
    '--- EXECUTOR SAFETY RULES ---',
    'Reject the plan if any minimal_action_set step contains any of the following:',
    '  - unresolved placeholder targets such as <path-to-file> or other angle-bracket placeholders',
    '  - file or directory targets outside target_project_path',
    '  - shell-wrapped commands such as cmd /c, powershell -c, bash -lc, sh -c',
    ...(benchmarkShellSyntaxAllowed
      ? [
          '  - directory-changing wrappers such as cd ... &&',
          '  - outside Docker-backed benchmark_container only: command chaining, pipes, or redirects',
        ]
      : [
          '  - command chaining or directory-changing wrappers such as cd ... &&',
        ]),
    '  - shell_exec/test_run commands whose executable base is not in the executor allowlist',
    ...(benchmarkShellSyntaxAllowed
      ? [
          '  - benchmark_container dependency-install commands such as pip install, python -m pip install, uv pip install, apt-get update/install, or conda install unless the task explicitly requests dependency installation',
        ]
      : []),
    '  - redundant mkdir/mkdir -p directory-creation steps when a later file_write would create the parent directory automatically',
    '  - gradle/gradlew verification steps that assume Java exists when the runtime preflight says Java is missing and the plan does not bootstrap/configure Java first',
    '  - `gradle ...` steps that assume global Gradle exists when the runtime preflight says Gradle is missing and the plan does not install/configure Gradle first',
    'Use INCOMPLETE_SUBMISSION for unresolved placeholders.',
    'Use SFDIPOT-P for executor/runtime-incompatible paths or shell-wrapped commands.',
    `Executor allowlist command bases: ${allowedShellCommands.join(', ')}`,
    `Current Java runtime preflight: ${javaRuntimeStatus.summary}`,
    `Current Gradle runtime preflight: ${gradleRuntimeStatus.summary}`,
    `Current Android SDK runtime preflight: ${androidSdkStatus.summary}`,
    ...(benchmarkRuntimeInventoryLines.length > 0
      ? [
          '',
          '--- BENCHMARK RUNTIME INVENTORY ---',
          ...benchmarkRuntimeInventoryLines,
        ]
      : []),
    ...(toolCapabilityLines.length > 0
      ? [
          '',
          '--- TOOL CAPABILITY BROKER ---',
          ...toolCapabilityLines,
        ]
      : []),
    ...(benchmarkVerificationLines.length > 0
      ? [
          '',
          '--- BENCHMARK PRE-COMPLETE VERIFICATION ---',
          ...benchmarkVerificationLines,
        ]
      : []),
    ...(deterministicGradleBootstrapLaneActive
      ? [
          'Deterministic Gradle bootstrap lane status: ACTIVE.',
          'When this lane is ACTIVE, the executor/runtime owns Gradle provisioning, root build bootstrap repair, wrapper generation, and halting if bootstrap fails.',
          'Do NOT reject a plan merely because global gradle is missing when the plan only uses post-bootstrap wrapper commands such as `gradlew tasks` or `gradlew assembleDebug`.',
          'Do NOT require the plan to include its own bootstrap/failure-handling steps for gradle-wrapper.jar generation when the lane is ACTIVE.',
          'Only reject for Gradle/bootstrap reasons if the plan still includes forbidden global `gradle ...` commands, mirrored Gradle file probes, or other executor-incompatible steps.',
        ]
      : []),
    '',
    '--- EXECUTION PROFILE ---',
    ...executionProfileLines,
    ...(shouldApplyHostWindowsExecutorNotes(executionProfileName)
      ? [
          'Windows-specific rule: do NOT reject a plan merely because it does not include wrapper permission, chmod, or Unblock-File steps for `gradlew` / `gradlew.bat`.',
          'Only reject for Windows wrapper-permission issues if the grounded evidence explicitly shows the wrapper file is blocked, unreadable, or failing because of a permission/MOTW issue.',
          'Windows-specific executor rule: reject POSIX env-prefix command syntax such as `FOO=bar ./script`.',
          'Windows-specific executor rule: reject POSIX-only command bases such as `chmod`, `bash`, or `sh` unless the runtime contract explicitly allows them.',
        ]
      : []),
    'Wrapper rule: if gradlew / gradlew.bat already exists in the target project, do NOT reject a plan merely because global gradle is unavailable on PATH when the plan uses wrapper-based commands only.',
    ...(boundedQaLines.length > 0
      ? [
          '',
          ...boundedQaLines,
        ]
      : []),
    '',
    'PASS shape:   { "verdict": "PASS", "overall_confidence": <1-5>, "notes": "..." }',
    'REJECT shape: { "verdict": "REJECT", "failure_count": <N>, "overall_confidence": <1-5>,',
    '  "failures": [{ "tag": "NAMIT-I", "condition": "...", "confidence": <1-5> }],',
    '  "proposed_fix_strategy": "<one-sentence direction for the SWE Agent — dimension only, no code>" }',
    'IMPORTANT: tag must be a BARE string — NO square brackets — from this exact list:',
    '  INCOMPLETE_SUBMISSION | EVIDENCE-GATE',
    '  SFDIPOT-S | SFDIPOT-F | SFDIPOT-D | SFDIPOT-I | SFDIPOT-P | SFDIPOT-O | SFDIPOT-T',
    '  NAMIT-N | NAMIT-A | NAMIT-M | NAMIT-I | NAMIT-T',
    '  BCDP-MISSING | BCDP-BREAKING-UNMARKED | BCDP-NO-MIGRATION | BCDP-NO-ROLLBACK',
    '  SECURITY-INJECTION | SECURITY-SECRETS | SECURITY-AUTHZ | SECURITY-EXPOSURE',
    '  ROOT-CAUSE-MISSING | ROOT-CAUSE-SHALLOW',
    '',
    'SWE Plan to review:',
    JSON.stringify(swePlan, null, 2),
  ].join('\n');
}
