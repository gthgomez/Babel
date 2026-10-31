import { readFileSync } from 'node:fs';
import { join } from "node:path";
import { Command } from "commander";
import { renderProductBanner } from "../ui/renderers.js";
import { warning, muted } from "../ui/theme.js";
import { readRuntimeMode } from "../config/runtimeMode.js";
import { resolveRuntimePaths } from '../config/runtimePaths.js';
import { registerInternalTextProviderCommands } from "./liteCommands.js";

import { registerCoreStartupCommands } from './coreStartupCommands.js';
import { registerCoreAutomationCommands } from './coreAutomationCommands.js';
import { registerCoreLearningCommands } from './coreLearningCommands.js';
import { registerCoreInspectionCommands } from './coreInspectionCommands.js';
import { registerCoreExtensionCommands } from './coreExtensionCommands.js';
import { registerCoreGitCommands } from './coreGitCommands.js';
import { registerCoreBenchmarkCommands } from './coreBenchmarkCommands.js';
import { registerCoreMemoryPlanCommands } from './coreMemoryPlanCommands.js';
import { registerCoreExecutionCommands } from './coreExecutionCommands.js';
import { registerResearchCommands } from './researchCommands.js';
import { registerConnectionCommands } from './connectionCommands.js';
import { currentInvocationSettings } from '../config/invocationSettings.js';
import { selectedConnectionModel } from '../services/connectionSettings.js';
import { resolveEffectiveSettings } from '../config/userSettings.js';
import { resolveAgentTarget } from '../services/targetResolver.js';
import { resolveProjectRoot } from '../cli/helpers.js';
import { assertFiniteBudgetSupported } from '../config/laneBudget.js';
export { validateRuntimeEnvForCommand } from './coreCommandSupport.js';
export { buildApprovalProfilePayload } from './coreCommandSupport.js';
export { resolveBenchmarkProvider } from './coreCommandSupport.js';
export { resolveBenchmarkAnalyzeRun } from './coreCommandSupport.js';

const TOP_LEVEL_HELP_TEXT = `
Start:
  babel-agent setup                         Connect your provider, exact model and budget
  babel-agent                               Open the interactive coding session
  babel-agent work "Explain this project"    Inspect or implement within current permissions
  babel-agent plan "Design this change"      Produce a read-only plan
  babel-agent apply --plan <id>              Apply a saved plan after scope checks
  babel-agent work --review thorough "..."   Use governed planning, review and execution

Settings:
  babel-agent provider list
  babel-agent provider use <connection> --save user
  babel-agent model use <exact-id> --save project
  babel-agent settings show
  babel-agent conversation list             List saved conversations
  babel-agent conversation resume <id>      Resume a conversation
  babel-agent run resume <id>               Recover an execution worker chain
  babel-agent doctor

Plan stops by default. Only an explicitly saved plans.autoApply preference enables
automatic implementation. --plan-only always stops. No cloud provider is preselected.
Model/provider choices inside the TUI are session-scoped; --save user|project makes
persistence explicit. Advanced and compatibility commands: babel-agent advanced.
`;

export function applyProgramMetadata(program: Command): void {
  const installed = resolveRuntimePaths().isInstalled;
  // These contributor utilities create prompt/benchmark artifacts in the source
  // library. A preview installation has immutable resources and fails closed.
  if (installed) program.hook('preAction', (_root, action) => {
    let command = action;
    while (command.parent && command.parent !== program) command = command.parent;
    if (['learn', 'skill', 'benchmark', 'smoke', 'test', 'audit'].includes(command.name())) {
      program.error(`${command.name()} requires a contributor checkout in this preview.`);
    }
    if (command.name() === 'run' && action.opts()['benchmark']) {
      program.error('run --benchmark requires a contributor checkout in this preview.');
    }
  });
  program
    .name(installed ? 'babel-agent' : 'babel')
    .description(
      "Babel coding agent — inspect, plan and change projects using your chosen provider",
    )
    .version((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version)
    .addHelpText("after", TOP_LEVEL_HELP_TEXT);
}

const DEFAULT_HELP_COMMANDS = new Set([
  "setup",
  "provider",
  "model",
  "settings",
  "conversation",
  "doctor",
  "dry",
  "permissions",
  "interactive",
  "plan",
  "deep",
  "undo",
  "resume",
  "inspect",
  "advanced",
]);

const ADVANCED_HELP_GROUPS: Array<[string, string[]]> = [
  ["Primary CLI", ["plan", "deep", "resume", "undo", "inspect", "doctor"]],
  ["Compatibility", ["do", "fix", "ask", "propose", "review", "lite"]],
  ["Advanced pipeline", ["run"]],
  [
    "Readiness",
    ["setup", "doctor", "simplify", "docs", "dry", "permissions", "models"],
  ],
  [
    "Evidence",
    [
      "prove",
      "learn",
      "evidence",
      "inspect",
      "session",
      "checkpoint",
      "diagnose",
      "stats",
    ],
  ],
  ["Delivery", ["ship", "git", "ci", "schedule", "jobs"]],
  ["Benchmarks", ["benchmark", "smoke", "test"]],
  [
    "Project tools",
    ["files", "verify", "diff", "repo-map", "onboard-project", "create"],
  ],
  ["Extensions", ["plugins", "agents", "skill", "codex"]],
  ["Research", ["research"]],
  [
    "Internals",
    [
      "internals",
      "mcp",
      "mode",
      "tools",
      "events",
      "context",
      "escalation",
      "shadow-diff",
    ],
  ],
];

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find(
    (command) => command.name() === name || command.aliases().includes(name),
  );
}

function formatHelpGroups(
  program: Command,
  title: string,
  groups: Array<[string, string[]]>,
): string {
  const lines = [title, ""];
  for (const [group, names] of groups) {
    lines.push(`${group}:`);
    for (const name of names) {
      const command = findCommand(program, name);
      if (!command) {
        continue;
      }
      const aliases = command.aliases();
      const aliasText = aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
      const description =
        command.name() === "run"
          ? "Advanced pipeline lane: explicit modes, audit, output, and tool/model controls"
          : command.name() === "deep"
            ? "Heavy governance path: critique, refine, implement, and verify"
            : command.description();
      lines.push(`  ${command.name()}${aliasText} - ${description}`);
    }
    lines.push("");
  }
  lines.push('Tip: run "babel <command> --help" for command-specific options.');
  return lines.join("\n");
}

export function applyUserFocusedHelpTiers(program: Command): void {
  for (const command of program.commands) {
    if (!DEFAULT_HELP_COMMANDS.has(command.name())) {
      (command as unknown as { _hidden: boolean })._hidden = true;
    }
  }

  program
    .command("advanced")
    .description("Show advanced Babel command groups")
    .addHelpText(
      "after",
      `
Notes:
  - Prefer babel "<task>", babel plan, and babel deep for daily work.
  - babel run is for explicit pipeline modes, audit flags, JSON event streams, and governed controls.
  - Prefer babel "<task>", babel plan, and babel deep before advanced run flags.
  - Internal pipeline mode names stay under "babel run --help".
`,
    )
    .action(() => {
      console.log(
        formatHelpGroups(
          program,
          "Babel Advanced Commands",
          ADVANCED_HELP_GROUPS,
        ),
      );
    });

  const internalsCommand = program
    .command("internals")
    .description("Show internal command groups")
    .action(() => {
      console.log(
        formatHelpGroups(program, "Babel Internal Commands", [
          ["Control plane", ["mcp", "mode", "tools", "events", "context"]],
          [
            "Runtime evidence",
            ["inspect", "session", "checkpoint", "stats", "diagnose"],
          ],
          [
            "Automation",
            [
              "agents",
              "plugins",
              "schedule",
              "jobs",
              "approvals",
              "escalation",
            ],
          ],
          [
            "Legacy compatibility",
            ["resume", "apply", "smoke", "test", "shadow-diff"],
          ],
          ["Text provider lane", ["text-provider"]],
        ]),
      );
    });
  (internalsCommand as unknown as { _hidden: boolean })._hidden = true;

  registerInternalTextProviderCommands(program);
}

export function printBanner(): void {
  const runtimeMode = readRuntimeMode();
  const isDryRun = process.env["BABEL_DRY_RUN"] === "true";

  const modeTag = runtimeMode === "plan" ? warning(" [PLANNING]") : "";
  const dryTag = isDryRun ? muted(" [DRY RUN]") : "";

  process.stdout.write(
    renderProductBanner(
      "Multi-Agent OS Runtime Harness",
      `${modeTag}${dryTag}`,
    ) + "\n",
  );
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerCoreCommands(program: Command): void {
  registerConnectionCommands(program, { projectRoot: resolveAgentTarget().targetRoot });
  program.option('--connection <id>', 'Use a configured provider connection for this invocation');
  program.hook('preAction', (_root, action) => {
    const connection = program.opts()['connection'];
    const invocation = currentInvocationSettings();
    if (typeof connection === 'string' && invocation) invocation.connection = connection;
    if (action.opts()['headless'] === true && invocation) invocation['presentation'] = 'plain';
    // Nested commands such as agents run have their own offline/service contracts.
    if (action.parent !== program) return;
    const explicitModel = action.getOptionValueSource('model') === 'cli' ? action.opts()['model'] : undefined;
    if (typeof explicitModel === 'string' && invocation) invocation.model = explicitModel;
    const planArgs = action.name() === 'plan' && Array.isArray(action.processedArgs[0]) ? action.processedArgs[0] as string[] : [];
    const project = action.opts()['project'] ?? (planArgs.length > 1 && resolveProjectRoot(planArgs[0]!) ? planArgs[0] : undefined);
    const target = resolveAgentTarget({ ...(project ? { project } : {}),
      ...(action.opts()['projectRoot'] ? { projectRoot: action.opts()['projectRoot'] } : {}), cwd: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd() }).targetRoot;
    if (action.name() === 'run') {
      const effective = resolveEffectiveSettings({ projectRoot: target });
      const explicitMode = action.getOptionValueSource('mode') === 'cli';
      const mode = explicitMode ? action.opts()['mode'] : effective.workflow.value === 'plan' ? 'plan' : 'chat';
      const review = action.opts()['review'] ?? effective.review.value;
      if (!['standard', 'thorough'].includes(review)) throw new Error('Review must be standard or thorough.');
      action.setOptionValueWithSource('mode', ['chat', 'chat-headless'].includes(mode) && review === 'thorough' ? 'deep' : mode, explicitMode ? 'cli' : 'config');
      if (['plan', 'deep'].includes(action.opts()['mode'])) assertFiniteBudgetSupported('Plan or thorough Work', target);
    }
    if (['run', 'plan', 'deep', 'interactive', 'app'].includes(action.name()) && action.opts()['model'] === undefined) {
      const selected = selectedConnectionModel({}, target);
      if (selected) action.setOptionValue('model', selected);
      else if (process.env['BABEL_MODEL']) action.setOptionValue('model', process.env['BABEL_MODEL']);
    } else if (['run', 'plan', 'deep', 'interactive', 'app'].includes(action.name()) && typeof action.opts()['model'] === 'string' && !action.opts()['model'].startsWith('connection/')) {
      const selected = selectedConnectionModel({ model: action.opts()['model'] }, target);
      if (selected) action.setOptionValue('model', selected);
    }
    if (['run', 'plan', 'deep'].includes(action.name()) && !action.opts()['model'] && !action.opts()['manual'] &&
      !process.env['BABEL_DESKTOP_PROVIDER'] && process.env['BABEL_PIPELINE_V9_OFFLINE'] !== '1' &&
      process.env['BABEL_LITE_OFFLINE'] !== '1' && !['1', 'true'].includes(process.env['BABEL_OFFLINE'] ?? '')) {
      throw new Error('SETUP_REQUIRED: Run babel-agent setup to choose a provider connection and exact model before starting work.');
    }
  });
  registerCoreStartupCommands(program);
  registerCoreAutomationCommands(program);
  registerCoreLearningCommands(program);
  registerCoreInspectionCommands(program);
  registerCoreExtensionCommands(program);
  registerCoreGitCommands(program);
  registerCoreBenchmarkCommands(program);
  registerCoreMemoryPlanCommands(program);
  registerCoreExecutionCommands(program);
  registerResearchCommands(program);
}
