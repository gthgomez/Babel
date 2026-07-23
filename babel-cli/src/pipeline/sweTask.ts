import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_EXECUTION_PROFILE,
  buildExecutionProfilePromptLines,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { shouldUseDockerSandbox } from '../config/benchmarkContainer.js';
import { buildToolCapabilityPromptLines } from '../config/toolCapabilities.js';
import { getAllowedShellCommands } from '../sandbox.js';
import type { OrchestratorManifest } from '../schemas/agentContracts.js';
import {
  detectAndroidSdkStatus,
  detectCommandOnPath,
  detectJavaRuntimeStatus,
  type CommandRuntimeStatus,
} from '../stages/runtimePreflight.js';
import { getBoundedTaskPlanningLines, mergeTaskContext } from '../stages/taskShape.js';
import { buildBenchmarkVerificationPromptLines } from '../stages/benchmarkVerification.js';
import { EXECUTOR_TOOL_NAMES } from '../tools/toolContracts.js';
import { getDiscoverySummary } from './prePlanningDiscovery.js';
import {
  getBenchmarkRuntimeInventoryLines,
  shouldApplyHostWindowsExecutorNotes,
} from './benchmarkRuntime.js';
import { isExternalBenchmarkTask } from './benchmarkTasks.js';
import { inferProjectRoot } from './manifestContext.js';
import { isAndroidSourceOnlyWorkspace } from './androidWorkspace.js';

function getBenchmarkHarnessPlanningLines(rawTask: string): string[] {
  if (!isExternalBenchmarkTask(rawTask)) {
    return [];
  }

  return [
    'Benchmark harness rule: treat the provided project root as /app and use root-relative paths only.',
    'Benchmark harness rule: if the task names an output artifact, create it at that exact path.',
    'Benchmark harness rule: do not inspect hidden verifier tests; solve from the task statement and visible files.',
    'Benchmark harness rule: do not modify visible verifier/input fixtures such as test_outputs.py. For break-filter-js-from-html, do not modify filter.py; repair out.html or write a separate helper script.',
  ];
}

function getManyFileAggregationPlanningLines(rawTask: string): string[] {
  const manyFileAggregationTask =
    /\b(all|multiple|every)\s+(?:log\s+)?files\b/i.test(rawTask) || /\ball\s+logs\b/i.test(rawTask);
  const aggregationOutputTask =
    /\b(count|aggregate|summari[sz]e|analy[sz]e)\b/i.test(rawTask) &&
    /\b(csv|json|summary|report)\b/i.test(rawTask);
  if (!manyFileAggregationTask || !aggregationOutputTask) {
    return [];
  }

  return [
    'Many-file aggregation rule: write a small helper program with file_write and run it with shell_exec/test_run; this exception supersedes the generic no-wrapper-script rule because the task requires processing all files deterministically.',
    'Many-file aggregation plan shape: directory_list input directory, file_write helper script, shell_exec/test_run helper command, then file_read or shell_exec sanity check of the generated output.',
    'Many-file aggregation ban: do not use file_read sampling as the aggregation method and do not hand-write aggregate results from sampled files.',
    'Date-window aggregation rule: when a task says "last N days including today", count exactly N calendar dates by starting at reference_date - (N - 1) days and including both start and end dates.',
    'Structured log counting rule: when severities are encoded as tokens such as [ERROR], [WARNING], or [INFO], count the exact token field rather than prose mentions of those words inside log messages.',
  ];
}

export function buildSweTask(
  manifest: OrchestratorManifest,
  originalTaskContext: string,
  qaRejections: string[],
  proposedFixStrategy: string | undefined,
  evidenceContext: string = '',
  groundingContext: string = '',
  executionProfileName: ExecutionProfileName = DEFAULT_EXECUTION_PROFILE,
): string {
  const userRequest = mergeTaskContext(originalTaskContext, manifest.handoff_payload.user_request);
  const allowedShellCommands = getAllowedShellCommands(executionProfileName);
  const executionProfileLines = buildExecutionProfilePromptLines(executionProfileName, 'swe');
  const benchmarkShellSyntaxAllowed = shouldUseDockerSandbox(executionProfileName);
  const projectRoot = inferProjectRoot(manifest);
  const boundedPlanningLines = getBoundedTaskPlanningLines(userRequest);
  const benchmarkHarnessPlanningLines = getBenchmarkHarnessPlanningLines(userRequest);
  const manyFileAggregationPlanningLines = getManyFileAggregationPlanningLines(userRequest);
  const benchmarkRuntimeInventoryLines = getBenchmarkRuntimeInventoryLines(executionProfileName);
  const toolCapabilityLines = buildToolCapabilityPromptLines(executionProfileName);
  const benchmarkVerificationLines = buildBenchmarkVerificationPromptLines(userRequest);
  // Pre-planning discovery: scan the project root for files and config so the
  // planner can use real paths instead of guessing from task text alone.
  const discoveryContext = projectRoot ? getDiscoverySummary(projectRoot) : null;
  const projectRootLines: string[] = [];
  const wrapperBootstrapLines: string[] = [];
  const runtimePreflightLines: string[] = [];
  const deterministicLaneLines: string[] = [];
  const javaRuntimeStatus = detectJavaRuntimeStatus();
  const gradleRuntimeStatus = detectCommandOnPath('gradle');
  const androidSdkStatus = detectAndroidSdkStatus();
  const wingetRuntimeStatus =
    process.platform === 'win32'
      ? detectCommandOnPath('winget')
      : ({
          available: false,
          source: 'missing',
          summary: 'winget is unavailable on non-Windows platforms.',
          command: 'winget',
          resolvedPath: null,
        } satisfies CommandRuntimeStatus);

  const thinkingRequirement = `
### IMPORTANT: INTERNAL MONOLOGUE (THINKING LAYER)
Your JSON output MUST include a "thinking" field. Use this field to:
1.  Critique your own plan and identify potential edge cases.
2.  Verify that your proposed changes adhere to the project's long-term memories.
3.  Double-check all file paths and tool arguments.
4.  If performing a file_write, reason about the imports and potential breaking changes.
`;

  if (projectRoot) {
    projectRootLines.push(`Target project root: ${projectRoot}`);

    if (existsSync(projectRoot)) {
      const topLevelEntries = readdirSync(projectRoot, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`);
      const hasExistingAndroidProject =
        existsSync(join(projectRoot, 'app')) ||
        existsSync(join(projectRoot, 'settings.gradle.kts')) ||
        existsSync(join(projectRoot, 'app', 'build.gradle.kts')) ||
        existsSync(join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml'));
      const androidSourceOnlyWorkspace = isAndroidSourceOnlyWorkspace(projectRoot);

      projectRootLines.push(
        `Current top-level entries: ${topLevelEntries.length > 0 ? topLevelEntries.join(', ') : '(empty)'}`,
      );
      projectRootLines.push(
        hasExistingAndroidProject
          ? 'Existing target state: partial Android project already exists at the target root. Continue in place; do not create a second nested app root.'
          : 'Existing target state: no Android project markers detected yet at the target root.',
      );
      if (androidSourceOnlyWorkspace) {
        projectRootLines.push(
          'Android source-only workspace detected: Kotlin/Java source paths exist, but no Gradle build markers were found. Treat this as a bounded source-file task; do not bootstrap Gradle or require gradlew verification.',
        );
      }

      const wrapperPropertiesPath = join(
        projectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties',
      );
      const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
      const gradlewPath = join(projectRoot, 'gradlew');
      const gradlewBatPath = join(projectRoot, 'gradlew.bat');
      const wrapperPropertiesExists = existsSync(wrapperPropertiesPath);
      const wrapperJarExists = existsSync(wrapperJarPath);
      const gradlewExists = existsSync(gradlewPath);
      const gradlewBatExists = existsSync(gradlewBatPath);
      const rootBuildGradlePath = join(projectRoot, 'build.gradle.kts');
      const appBuildGradlePath = join(projectRoot, 'app', 'build.gradle.kts');
      const rootBuildGradleExists = existsSync(rootBuildGradlePath);
      const appBuildGradleExists = existsSync(appBuildGradlePath);
      const referenceMonteCarloRoot = join(projectRoot, 'reference-montecarlo-ledger');
      const referenceMonteCarloExists = existsSync(referenceMonteCarloRoot);
      const referenceMonteCarloLooksLikePython =
        referenceMonteCarloExists &&
        (existsSync(join(referenceMonteCarloRoot, 'pyproject.toml')) ||
          existsSync(join(referenceMonteCarloRoot, 'requirements.txt')) ||
          existsSync(join(referenceMonteCarloRoot, 'monte_carlo_ledger')));

      projectRootLines.push(
        `Gradle wrapper state: properties=${wrapperPropertiesExists ? 'present' : 'missing'}, jar=${wrapperJarExists ? 'present' : 'missing'}, gradlew=${gradlewExists ? 'present' : 'missing'}, gradlew.bat=${gradlewBatExists ? 'present' : 'missing'}`,
      );
      projectRootLines.push(
        `Build file state: root build.gradle.kts=${rootBuildGradleExists ? 'present' : 'missing'}, app/build.gradle.kts=${appBuildGradleExists ? 'present' : 'missing'}, settings.gradle.kts=${existsSync(join(projectRoot, 'settings.gradle.kts')) ? 'present' : 'missing'}`,
      );
      runtimePreflightLines.push(`Executor Java runtime: ${javaRuntimeStatus.summary}`);
      runtimePreflightLines.push(`Executor Gradle runtime: ${gradleRuntimeStatus.summary}`);
      runtimePreflightLines.push(`Executor Android SDK runtime: ${androidSdkStatus.summary}`);
      runtimePreflightLines.push(`Executor winget runtime: ${wingetRuntimeStatus.summary}`);
      if (referenceMonteCarloLooksLikePython) {
        runtimePreflightLines.push(
          'Reference source shape: reference-montecarlo-ledger is a non-Android Python repo (pyproject/requirements/monte_carlo_ledger present). Do NOT assume Android package paths or Gradle files inside the reference source. Read the actual Python files under reference-montecarlo-ledger/README.md, pyproject.toml, monte_carlo_ledger/*.py, and docs/** first.',
        );
      }

      if (
        !androidSourceOnlyWorkspace &&
        (!gradlewExists || !gradlewBatExists || !wrapperPropertiesExists)
      ) {
        wrapperBootstrapLines.push(
          'Wrapper bootstrap mode is ACTIVE.',
          'If gradle/wrapper/gradle-wrapper.properties exists in the target root, treat that target file as the source of truth and create missing gradlew / gradlew.bat directly with file_write.',
          'Do NOT plan file_read or directory_list steps against wrapper files in the mirrored reference repo unless those exact wrapper files are already known to exist there.',
          'Known wrapper generation rule:',
          '  - write gradlew as a standard POSIX Gradle launcher script that invokes "%APP_HOME%/gradle/wrapper/gradle-wrapper.jar" via Java when present',
          '  - write gradlew.bat as a standard Windows Gradle launcher script that invokes "%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar" via Java when present',
          '  - if gradle-wrapper.properties is missing, create it directly at gradle/wrapper/gradle-wrapper.properties with a valid Gradle distributionUrl before creating wrapper scripts',
          '  - if wrapper scripts are missing, create them directly in the target root instead of trying to copy or inspect them from the mirrored source repo',
          '  - if gradle-wrapper.jar is also missing, prefer a direct shell_exec step like "gradle wrapper" in the target root after the project files are in place',
        );
      }

      if (!androidSourceOnlyWorkspace && !gradleRuntimeStatus.available && !wrapperJarExists) {
        wrapperBootstrapLines.push(
          'Gradle bootstrap sequencing is REQUIRED because gradle-wrapper.jar is missing and global gradle is also missing.',
          'A deterministic executor bootstrap lane will provision Gradle and generate gradle-wrapper.jar before normal execution begins.',
          'Do NOT spend plan steps on installing Gradle, running `gradle --version`, or running `gradle wrapper` when this lane is active.',
          'The plan MUST provision Gradle first (for example via winget install) BEFORE any step that runs `gradle wrapper`, `gradle --version`, or other global Gradle commands.',
          'Do NOT place `gradle --version` before the Gradle provisioning step.',
          'Do NOT plan any file_read or directory_list steps against known-missing mirrored Gradle files while bootstrapping Gradle.',
          'Until the lane completes, focus the action set on concrete project files and post-bootstrap verification/build steps only.',
        );
        deterministicLaneLines.push(
          'Deterministic Gradle bootstrap lane is ACTIVE for this task.',
          'The plan must assume wrapper/bootstrap prerequisites will be satisfied before normal execution begins.',
          'BANNED plan steps while this lane is active:',
          '  - `winget install Gradle.Gradle` or any other Gradle provisioning command',
          '  - `gradle --version`',
          '  - `gradle wrapper`',
          '  - reading `gradle-wrapper.jar` as if it already exists',
          '  - verifying future APK output files by reading them before the build runs',
          'Allowed post-bootstrap work:',
          '  - read existing project files that already exist',
          '  - create missing build files directly with file_write when target files are missing',
          '  - run wrapper-based commands like `gradlew tasks` or `gradlew assembleDebug` after bootstrap',
        );
      }

      if (
        !androidSourceOnlyWorkspace &&
        !gradleRuntimeStatus.available &&
        wrapperJarExists &&
        (gradlewExists || gradlewBatExists)
      ) {
        deterministicLaneLines.push(
          'Existing Gradle wrapper mode is ACTIVE for this task.',
          'The target project already has gradlew / gradlew.bat and gradle-wrapper.jar, while global gradle is missing from PATH.',
          'BANNED plan steps in this mode:',
          '  - any global `gradle ...` command, including `gradle --version` and `gradle wrapper`',
          '  - provisioning or re-creating the wrapper when the existing wrapper files are already present',
          'Required behavior in this mode:',
          '  - use only wrapper-based commands such as `gradlew tasks` or `gradlew assembleDebug` for build verification',
          '  - treat wrapper execution as the canonical Gradle path for this task',
        );
      }

      if (!androidSourceOnlyWorkspace && !rootBuildGradleExists) {
        deterministicLaneLines.push(
          'Target root build.gradle.kts is currently missing. If needed, CREATE it directly with file_write; do not try to file_read it first.',
        );
      }
      if (appBuildGradleExists) {
        deterministicLaneLines.push(
          'Target app/build.gradle.kts already exists. Prefer reading this real target file instead of any mirrored build.gradle.kts.',
        );
      }
    } else {
      projectRootLines.push('Current top-level entries: target root does not exist yet.');
    }
  }

  const lines = [
    'Analyze the task below and produce the SWE Plan as a single raw JSON object.',
    'Respond with ONLY valid JSON — no markdown fences, no explanation, no tool calls.',
    '',
    'Required JSON shape:',
    '{',
    '  "plan_version": "1.0",',
    '  "plan_type": "EVIDENCE_REQUEST|IMPLEMENTATION_PLAN",',
    '  "task_summary": "OBJECTIVE: <one-sentence summary>",',
    '  "known_facts":  ["<fact>"],',
    '  "assumptions":  ["<assumption>"],',
    '  "risks": [{ "risk": "...", "likelihood": "low|medium|high", "mitigation": "..." }],',
    '  "minimal_action_set": [{',
    '    "step": 1, "description": "...",',
    `    "tool": "${EXECUTOR_TOOL_NAMES.join('|')}",`,
    '    "target": "<path or command>", "rationale": "...",',
    '    "reversible": true, "verification": "<how to confirm success>"',
    '  }],',
    '  "root_cause": "N/A — feature request",',
    '  "out_of_scope": ["<excluded item>"]',
    '}',
    '',
    `Task: ${userRequest}`,
    ...(boundedPlanningLines.length > 0 ? ['', ...boundedPlanningLines] : []),
    ...(projectRootLines.length > 0 ? ['', 'Target project context:', ...projectRootLines] : []),
    ...(discoveryContext ? [discoveryContext] : []),
    '',
    'Execution profile guidance:',
    ...executionProfileLines.map((line) => `  - ${line}`),
    '',
    'Planning rules for executable steps:',
    '',
    '  --- VERIFICATION RULE (NON-NEGOTIABLE — plans are BLOCKED without this) ---',
    '  This is the #1 reason plans are rejected by the executor safety gate.',
    '  Every IMPLEMENTATION_PLAN with file_write steps MUST include at least one',
    '  verification command in a test_run or shell_exec step.',
    '  The verification step MUST appear BEFORE any file_write step in the action set.',
    '',
    '  HOW TO PICK A VERIFICATION COMMAND:',
    '  1. If the task text names a verifier command (e.g. "Run npm test before completing"),',
    '     use that exact command verbatim as a test_run step.',
    '  2. If the project has a package.json with a "test" script, use test_run: npm test.',
    '  3. If the project has a package.json with a "typecheck" script, add test_run: npm run typecheck.',
    '  4. For text-file tasks (create/update .txt, .md, .js, .ts, .py files), add:',
    '     shell_exec: type "<filepath>" (Windows) or shell_exec: cat "<filepath>" (Linux/Mac)',
    '     for every file the plan will write — do this BEFORE the file_write step.',
    '  5. For code fixes without a test command, use: shell_exec: node --test (if .test.js files exist)',
    '     or shell_exec: npx tsc --noEmit (if .ts files exist).',
    '',
    '  CONCRETE EXAMPLES of valid plans:',
    '    Task: "Create hello.txt containing the string world."',
    '      Step 1: shell_exec  target: type "hello.txt"      ← verifier BEFORE write',
    '      Step 2: file_write  target: hello.txt              ← write after verification',
    '',
    '    Task: "Create exact-status.txt containing the exact string autonomous exact ok."',
    '      Step 1: shell_exec  target: type "exact-status.txt"  ← verifier step',
    '      Step 2: file_write  target: exact-status.txt',
    '',
    '    Task: "Fix src/math.js. Run npm test before completing."',
    '      Step 1: file_read   target: src/math.js',
    '      Step 2: test_run    target: npm test              ← verifier from task text',
    '      Step 3: file_write  target: src/math.js',
    '',
    '    Task: "Create a new TypeScript file src/answer.ts with export const answer = 42."',
    '      Step 1: shell_exec  target: npx tsc --noEmit     ← verifier BEFORE write',
    '      Step 2: file_write  target: src/answer.ts',
    '',
    '  NEGATIVE EXAMPLES — these plans WILL be rejected:',
    '    WRONG: Step 1: file_write target: hello.txt  (no verification before write!)',
    '    WRONG: Step 1: shell_exec target: dir         (dir is not a verifier for file content)',
    '    WRONG: Step 1: file_write target: hello.txt, Step 2: file_read target: hello.txt',
    '           (verification AFTER write does not count — must be BEFORE)',
    '',
    '  If you are unsure which verifier to use, include a test_run: npm test step.',
    '  If you cannot determine ANY verifier, set plan_type to EVIDENCE_REQUEST instead.',
    '  Do NOT skip this rule even for trivial single-file tasks.',
    '  Plans without a verification step will be REJECTED by the executor safety gate.',
    '  If your plan is rejected, you will be asked to replan — save time by getting it right the first time.',
    '',
    '  --- TOOL USAGE RULES ---',
    '  - Use "directory_list" to inspect folders. Do NOT use "file_read" on a directory path.',
    '  - Use "file_read" only for actual files whose contents need inspection.',
    '  - Every file_read target must be a concrete file path. Never use placeholder targets like <path-to-main-source-file>.',
    '  - For "shell_exec" and "test_run", the target must be the executable command itself.',
    ...(benchmarkShellSyntaxAllowed
      ? [
          '  - Docker-backed benchmark_container may use POSIX pipes, redirects, and command chaining inside /app when that is the simplest way to create or verify the requested artifact.',
          '  - Do NOT wrap commands with "cmd /c", PowerShell, bash -lc, sh -c, or "cd ... &&"; use working_directory instead.',
          '  - Benchmark dependency rule: do NOT plan pip install, python -m pip install, uv pip install, apt-get update/install, conda install, or similar package installation unless the task explicitly requests dependency installation.',
          '  - If a benchmark command fails because a module or compiler is missing, prefer a source-only/file_write route using the existing container runtime instead of dependency installation.',
        ]
      : [
          '  - Do NOT wrap commands with "cmd /c", PowerShell, bash, shell chaining, helper scripts, or "cd ... &&".',
        ]),
    '  - Use project-root or module-root paths in working_directory instead of shell wrappers.',
    '  - file_write creates missing parent directories automatically. Do NOT add mkdir or mkdir -p steps just to prepare for a later file_write.',
    '  - Prefer file_write over shell-based bulk transforms. Do NOT create or run wrapper scripts to rewrite many files.',
    ...(benchmarkHarnessPlanningLines.length > 0
      ? benchmarkHarnessPlanningLines.map((line) => `  - ${line}`)
      : []),
    ...(manyFileAggregationPlanningLines.length > 0
      ? manyFileAggregationPlanningLines.map((line) => `  - ${line}`)
      : []),
    '  - If the target root already contains a partial project, continue by editing that existing tree in place.',
    '  - Do NOT create a second nested application root inside the target root unless the user explicitly asked for that.',
    '  - If a mirrored reference repo already lives inside the target root, read from that mirrored path instead of any external path.',
    '  - When a mirrored reference repo exists inside the target root, do NOT plan file_read steps against the same source repo through an external workspace path. Prefer the mirrored copy consistently.',
    '  - If the grounded context includes a "Reference source inventories" section, every file_read under a mirrored reference repo MUST use one of those listed real file paths exactly.',
    '  - Do NOT invent substitute source-module names inside a mirrored reference repo. If the inventory lists `budget_engine.py` and `forecasting.py`, do not replace them with guessed names such as `engine.py` or `models.py`.',
    '  - Prefer a small number of concrete file_read steps followed by direct file_write steps for the files that need to change.',
    `  - shell_exec/test_run command bases must come from the executor allowlist only: ${allowedShellCommands.join(', ')}.`,
    '  - When the task is to restore or generate missing wrapper/build scripts (for example gradlew or gradlew.bat), do NOT plan file_read steps against those missing files.',
    '  - If a required wrapper script is missing but its companion config exists (for example gradle/wrapper/gradle-wrapper.properties), read the existing config and then create the missing wrapper script directly with file_write.',
    '  - Do not use the mirrored reference repo as a source of truth for wrapper files unless those exact wrapper files actually exist there.',
    '  - Treat runtime prerequisites as part of the executable plan. Do not assume Java, JAVA_HOME, SDKs, or build tools exist unless the target context confirms that they do.',
    ...(javaRuntimeStatus.available
      ? [`  - Current Java preflight: ${javaRuntimeStatus.summary}.`]
      : [
          '  - Current Java preflight: Java is missing in the executor environment.',
          '  - If you plan any gradle/gradlew verification or build step, add an explicit Java bootstrap/configuration step BEFORE the first Gradle command.',
          '  - That bootstrap step must install or configure a JDK / JAVA_HOME, not just assume java exists.',
        ]),
    ...(gradleRuntimeStatus.available
      ? [`  - Current Gradle preflight: ${gradleRuntimeStatus.summary}.`]
      : [
          '  - Current Gradle preflight: global gradle is missing from PATH.',
          '  - If gradle-wrapper.jar is missing, do NOT plan a `gradle wrapper` step unless the plan first installs/configures Gradle or uses another explicit bootstrap path.',
          '  - When global gradle is absent and gradle-wrapper.jar is missing, the first global-Gradle-related step must be a provisioning step, not `gradle --version` and not a mirrored Gradle file read.',
          ...(wingetRuntimeStatus.available
            ? [
                '  - A valid recovery path is to install Gradle explicitly with winget before invoking `gradle wrapper`, because winget is available in this executor environment.',
              ]
            : []),
        ]),
    ...(isAndroidSourceOnlyWorkspace(projectRoot)
      ? [
          '  - Android source-only workspace: no Gradle build markers are present. Do NOT plan gradlew, Gradle bootstrap, Android SDK bootstrap, assembleDebug, or test steps. Verify this bounded task by reading and writing the requested Kotlin/Java files.',
        ]
      : androidSdkStatus.available
        ? [
            `  - Current Android SDK preflight: ${androidSdkStatus.summary}.`,
            '  - For Android build verification, prefer relying on the deterministic executor Android SDK lane rather than planning manual SDK discovery steps.',
            '  - If local.properties is missing, do NOT plan a file_read against it; the executor SDK lane can create or repair it directly.',
            '  - Autonomous Android port verification must include both `gradlew assembleDebug` and `gradlew test` before completion.',
            '  - Treat `gradlew assembleDebug` as the compile gate and `gradlew test` as the deeper correctness gate; do not stop after a green compile alone.',
            '  - Do not add `gradlew clean` to routine verification unless the task explicitly asks for a clean build or the prompt says the build artifacts are stale.',
            '  - For Android UI-improvement tasks, make verification-first planning the default: place `gradlew assembleDebug` and `gradlew test` in the first two executable steps, then inspect and edit the smallest UI surface needed.',
          ]
        : [
            '  - Current Android SDK preflight: no usable Android SDK has been discovered yet.',
            '  - If you plan Android build verification steps like `gradlew assembleDebug`, the plan must either provision/configure the Android SDK first or explicitly rely on an executor bootstrap lane when one is active.',
            '  - Do NOT treat missing local.properties as an existing file that must be read first; if needed, create it directly with file_write.',
          ]),
    ...(shouldApplyHostWindowsExecutorNotes(executionProfileName)
      ? [
          '  - Windows executor note: do NOT plan POSIX-only commands such as chmod, sh, or bash.',
          '  - Windows executor note: do NOT use POSIX env-prefix syntax such as FOO=bar ./script. Use supported commands and working_directory instead.',
        ]
      : []),
    ...(wrapperBootstrapLines.length > 0
      ? ['', 'Wrapper bootstrap context:', ...wrapperBootstrapLines]
      : []),
    ...(runtimePreflightLines.length > 0
      ? ['', 'Runtime preflight context:', ...runtimePreflightLines]
      : []),
    ...(benchmarkRuntimeInventoryLines.length > 0
      ? ['', 'Benchmark container runtime inventory:', ...benchmarkRuntimeInventoryLines]
      : []),
    ...(toolCapabilityLines.length > 0 ? ['', ...toolCapabilityLines] : []),
    ...(benchmarkVerificationLines.length > 0 ? ['', ...benchmarkVerificationLines] : []),
    ...(deterministicLaneLines.length > 0
      ? ['', 'Deterministic bootstrap context:', ...deterministicLaneLines]
      : []),
  ];

  if (qaRejections.length > 0) {
    lines.push(
      '',
      '--- QA REJECTION FEEDBACK ---',
      '',
      'Your previous plan was rejected. You MUST address ALL of the following',
      'failures in your revised plan. Do not omit any of them:',
      '',
      ...qaRejections.map((r, i) => `  ${i + 1}. ${r}`),
    );

    if (proposedFixStrategy) {
      lines.push(
        '',
        '--- QA DIRECTIONAL HINT ---',
        `The QA Reviewer suggested this direction: ${proposedFixStrategy}`,
        '(This is a dimension to address, not a complete fix. You must still',
        ' resolve every listed failure independently.)',
      );
    }

    lines.push('', 'Produce a corrected plan that eliminates every listed failure.');
  }

  if (evidenceContext) {
    lines.push(
      '',
      '--- GATHERED EVIDENCE ---',
      'The following context was collected by prior read-only evidence passes.',
      'Use it to produce a concrete implementation plan.',
      'Set "plan_type" to "IMPLEMENTATION_PLAN".',
      'Every IMPLEMENTATION_PLAN must include at least one post-edit verification step using shell_exec or test_run before any file_write step.',
      'Prefer verifier commands copied from the task text (for example "Run npm test before completing").',
      'If the task does not name a verifier, use npm test or npm run typecheck when package.json scripts exist.',
      'When no package.json scripts exist, synthesize a content-read verifier: shell_exec with "type <file>" (Windows) or "cat <file>" (Linux/Mac) for each text file the plan will write.',
      'Do NOT emit another EVIDENCE_REQUEST — proceed with full implementation.',
      '',
      evidenceContext.trim(),
    );
  }

  if (groundingContext.trim().length > 0) {
    lines.push('', groundingContext.trim());
  }

  if (groundingContext.includes('Reference source inventories')) {
    lines.push(
      '',
      '--- REFERENCE INVENTORY LOCK ---',
      'Treat any reference source inventory in the grounded context as a closed allowlist for file_read steps under that repository.',
      'Choose only exact paths from that inventory. Do not invent alternate module names, guessed file stems, or Android mirror paths for the Python reference repo.',
    );
  }

  lines.push('', thinkingRequirement);

  return lines.join('\n');
}
