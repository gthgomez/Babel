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
export { validateRuntimeEnvForCommand } from './coreCommandSupport.js';
export { buildApprovalProfilePayload } from './coreCommandSupport.js';
export { resolveBenchmarkProvider } from './coreCommandSupport.js';
export { resolveBenchmarkAnalyzeRun } from './coreCommandSupport.js';

const TOP_LEVEL_HELP_TEXT = `
Examples:
  $ babel                  # Launches interactive TUI session
  $ babel "Fix failing tests"
  $ babel plan "Split this safely"
  $ babel deep "Harden the migration path"
  $ babel doctor
  $ babel resume latest
  $ babel undo
  $ babel advanced

Command Guide:
  Interactive:  babel                  (or babel interactive / babel app)
  Default:      babel "<task...>"
  Plan:         babel plan "<task...>"
  Deep:         babel deep "<task...>"
  Recovery:     babel resume, babel undo
  Health:       babel doctor, babel inspect
  Advanced:     babel advanced

Notes:
  - Bare babel with no arguments launches the interactive TUI (REPL) session.
  - babel "<task...>" is the default one-shot action path — runs the task and exits.
  - babel plan prepares a plan, asks for approval in the terminal, then applies the approved task.
  - babel deep uses the heavier governed path when you want extra critique and execution rigor.
  - Daily work uses babel "<task>"; babel plan and babel deep cover planning and governed execution.
  - Shorthand is supported: babel <Project> "<task...>" maps to babel run --project <Project> "<task...>"
  - Use "babel advanced" for babel run, audit, benchmark, git, MCP, and inspection surfaces.
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
      "Babel Multi-Agent OS — local runtime harness for multi-repo workspaces",
    )
    .version((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version)
    .addHelpText("after", TOP_LEVEL_HELP_TEXT);
}

const DEFAULT_HELP_COMMANDS = new Set([
  "setup",
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
  registerCoreStartupCommands(program);
  registerCoreAutomationCommands(program);
  registerCoreLearningCommands(program);
  registerCoreInspectionCommands(program);
  registerCoreExtensionCommands(program);
  registerCoreGitCommands(program);
  registerCoreBenchmarkCommands(program);
  registerCoreMemoryPlanCommands(program);
  registerCoreExecutionCommands(program);
}
