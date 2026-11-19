/**
 * Help for the user-facing `work` verb.
 *
 * `work` is rewritten to `run --mode chat` before commander parses it, so
 * `babel work --help` used to print the advanced `run` usage line and options.
 * That contradicted the first-use entrypoint (UX-18). This text describes what
 * `work` actually does while keeping the same underlying options.
 */
import { CLI_COMMAND } from './commandName.js';

/** Whether argv asks for help specifically for the `work` verb. */
export function isWorkHelpRequest(argv: readonly string[]): boolean {
  if (argv[2] !== 'work') return false;
  return argv.slice(3).some((token) => token === '--help' || token === '-h');
}

/** Render the `work` help text. */
export function workHelpText(command: string = CLI_COMMAND): string {
  return `Usage: ${command} work [options] <task>

Inspect or implement inside the current project using current permissions.
Plain tasks stay conversational; --review thorough escalates to the governed
plan, review and execute path.

Arguments:
  task                          task prompt

Options:
  --review <depth>              standard | thorough (thorough = governed deep path)
  -p, --project <name>          Target project name resolved by the workspace scanner
  --project-root <path>         Explicit project root for an approved workspace repo
  -m, --model <model>           Override the model for this run
  --model-tier <tier>           Model policy tier
  --allow-expensive             Approve an expensive or policy-blocked model for this run
  --show-model-policy           Print the resolved backend model and cost metadata
  --headless                    Plain output; workflow, review and permission settings still apply
  --json                        Emit structured JSON only
  --ask                         Ask for approval before executing any mutating tool
  -h, --help                    display help for command

Examples:
  $ ${command} work "Explain this project"
  $ ${command} work "Fix the failing test" --review thorough
  $ ${command} work --project-root /tmp/my-repo "Add a CLI flag"

Notes:
  - ${command} work is the same pipeline as ${command} run --mode chat.
  - Use ${command} plan for a read-only plan and ${command} deep for governed work.
  - Advanced mode/output controls stay on ${command} run.
`;
}
