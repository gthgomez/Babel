import { resolveRuntimePaths } from '../config/runtimePaths.js';
import { runInstalledDoctor, installedSetupChecklist } from '../installedDoctor.js';
import { join, resolve } from "node:path";
import { Command } from "commander";
import { registerRunIntelligenceCommands } from './runIntelligenceCommands.js';
import { registerMaintenanceCommands } from "./maintenanceCommands.js";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { registerSkillCommands } from "./skillCommands.js";
import { getShadowDiff } from "../services/shadowDiff.js";
import { formatDoctorHuman, runDoctor, type DoctorScope } from "../doctor.js";
import { readRuntimeMode, writeRuntimeMode } from "../config/runtimeMode.js";
import { APPROVAL_PROFILE_DEFINITIONS, APPROVAL_PROFILES, parseApprovalProfile, readApprovalProfileStatus, writeApprovalProfile, type ApprovalProfileStatus } from "../config/approvalProfiles.js";
import { BABEL_ROOT } from "../cli/constants.js";
import { printDryRunState, readDryRunState, resolveProjectRoot, writeDryRunState } from "../cli/helpers.js";
import { formatSkillDoctorHuman, runSkillDoctor } from "../services/skillForge.js";
import { formatLocalStackResolveHuman, resolveLocalStack, type LocalCodexAdapter, type LocalModel, type LocalPipelineMode, type LocalProject, type LocalTaskCategory } from "../control-plane/localStackResolver.js";
import { buildApprovalProfilePayload, describePermissionProfile, exitWithRuntimeValidationFailure, validateRuntimeEnvForCommand } from './coreCommandSupport.js';

function handleDryMode(
  action: "status" | "on" | "off",
  options: { json?: boolean },
): void {
  try {
    const state =
      action === "on"
        ? writeDryRunState(true)
        : action === "off"
          ? writeDryRunState(false)
          : readDryRunState();
    printDryRunState(state, options.json === true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "fail",
            error: message,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`Error updating dry-run mode: ${message}`);
    }
    process.exit(1);
  }
}

function printApprovalProfileStatus(
  status: ApprovalProfileStatus,
  json: boolean,
): void {
  const payload = buildApprovalProfilePayload(status);
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(`What will happen: ${payload["action"]}`);
  console.log(`Scope: ${(payload["scope"] as string[]).join("; ")}`);
  console.log(`Cost: ${payload["cost"]}`);
  console.log(`Approval: ${payload["approval"]}`);
  console.log(`Profile: ${status.profile}`);
  console.log(`Config: ${status.profilePath}`);
  console.log("");
  if (status.profile === "custom") {
    console.log(
      "Current runtime controls do not exactly match a named approval profile.",
    );
  } else {
    console.log(APPROVAL_PROFILE_DEFINITIONS[status.profile].description);
  }
}

function handlePermissionsCommand(
  profileArg: string | undefined,
  options: { json?: boolean },
): void {
  try {
    if (!profileArg || profileArg.trim().toLowerCase() === "status") {
      printApprovalProfileStatus(
        readApprovalProfileStatus(),
        options.json === true,
      );
      return;
    }

    const profile = parseApprovalProfile(profileArg);
    if (!profile) {
      throw new Error(
        `Invalid approval profile "${profileArg}". Valid values: ${APPROVAL_PROFILES.join(", ")}`,
      );
    }

    printApprovalProfileStatus(
      writeApprovalProfile(profile),
      options.json === true,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "fail",
            error: message,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`Error updating permissions: ${message}`);
    }
    process.exit(1);
  }
}

function addDryModeOptions(command: Command): Command {
  return command.option("--json", "Emit structured JSON only");
}

function printSetupChecklist(options: { json?: boolean; contributor?: boolean }): void {
  if (resolveRuntimePaths().isInstalled && !options.contributor) {
    const payload = installedSetupChecklist();
    printJsonOrHuman(payload, payload.first_five_minutes.map(item => `${item.step}: ${item.command}${item.note ? ` — ${item.note}` : ""}`).join("\n"), options.json === true);
    return;
  }
  const payload = {
    status: "ok",
    kind: "first_five_minutes",
    first_five_minutes: [
      {
        step: "install_dependencies",
        command: "npm --prefix .\\babel-cli ci",
      },
      {
        step: "build_cli",
        command: "npm --prefix .\\babel-cli run build",
      },
      {
        step: "diagnose_workspace",
        command: "node .\\babel-cli\\dist\\index.js doctor --json",
      },
      {
        step: "safe_context_probe",
        command:
          "node .\\babel-cli\\dist\\index.js context preview @file README.md --json",
      },
      {
        step: "terminal_daily_profile",
        command: "set BABEL_DAILY_PROFILE=terminal",
        note: "Keeps daily CLI tasks on lite lanes unless you explicitly use babel deep or repo-wide risk applies.",
      },
    ],
    next_command:
      "node .\\babel-cli\\dist\\index.js context preview @file README.md --json",
    mutates_workspace: false,
    remote_side_effects: false,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log("Babel first five minutes");
  for (const item of payload.first_five_minutes) {
    const note =
      "note" in item && typeof item.note === "string" ? ` — ${item.note}` : "";
    console.log(`  ${item.step}: ${item.command}${note}`);
  }
}

export function registerCoreStartupCommands(program: Command): void {
registerRunIntelligenceCommands(program);

program.option(
    "--experimental",
    "Enable experimental features (daemon, goal loop)",
  );

program
    .command("resolve")
    .description(
      "Resolve a Babel Local Mode instruction stack using the canonical TypeScript resolver",
    )
    .option(
      "--task-category <category>",
      "Task category: frontend | backend | compliance | devops | research | mobile | game",
      "frontend",
    )
    .option("--project <project>", "Project overlay target", "global")
    .option(
      "--project-path <path>",
      "Concrete project path for repo-local context detection",
    )
    .option("--model <model>", "Model family: codex | claude | gemini", "codex")
    .option("--client-surface <surface>", "Client surface identifier")
    .option(
      "--pipeline-mode <mode>",
      "Pipeline mode: chat | chat-headless | plan | deep",
      "chat",
    )
    .option(
      "--codex-adapter <adapter>",
      "Codex adapter preference: auto | balanced | ultra",
      "auto",
    )
    .option("--task-overlay-id <id...>", "Additional task overlay id or alias")
    .option(
      "--task-prompt <prompt>",
      "Task prompt used for purpose and skill inference",
    )
    .option(
      "--purpose-mode <mode>",
      "Purpose mode: execution | verification | learning | exploration | audit",
    )
    .option(
      "--disable-recommended-task-overlays",
      "Disable automatic task overlay recommendations",
    )
    .option(
      "--load-all-skills",
      "Emergency/debug override: load every active skill",
    )
    .option(
      "--local-learning-root <path>",
      "Local learning root for active policies",
    )
    .option("--babel-root <path>", "Babel repository root", BABEL_ROOT)
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        taskCategory?: string;
        project?: string;
        projectPath?: string;
        model?: string;
        clientSurface?: string;
        pipelineMode?: string;
        codexAdapter?: string;
        taskOverlayId?: string[];
        taskPrompt?: string;
        purposeMode?: string;
        disableRecommendedTaskOverlays?: boolean;
        loadAllSkills?: boolean;
        localLearningRoot?: string;
        babelRoot?: string;
        json?: boolean;
      }) => {
        try {
          const result = resolveLocalStack({
            taskCategory: (options.taskCategory ??
              "frontend") as LocalTaskCategory,
            project: (options.project ?? "global") as LocalProject,
            ...(options.projectPath
              ? { projectPath: options.projectPath }
              : {}),
            model: (options.model ?? "codex") as LocalModel,
            ...(options.clientSurface
              ? { clientSurface: options.clientSurface }
              : {}),
            pipelineMode: (options.pipelineMode ?? "chat") as LocalPipelineMode,
            codexAdapter: (options.codexAdapter ?? "auto") as LocalCodexAdapter,
            taskOverlayIds: options.taskOverlayId ?? [],
            ...(options.taskPrompt ? { taskPrompt: options.taskPrompt } : {}),
            ...(options.purposeMode
              ? { purposeMode: options.purposeMode as never }
              : {}),
            disableRecommendedTaskOverlays:
              options.disableRecommendedTaskOverlays === true,
            loadAllSkills: options.loadAllSkills === true,
            ...(options.localLearningRoot
              ? { localLearningRoot: options.localLearningRoot }
              : {}),
            babelRoot: resolve(options.babelRoot ?? BABEL_ROOT),
          });
          printJsonOrHuman(
            result,
            formatLocalStackResolveHuman(result),
            options.json === true,
          );
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

program
    .command("setup")
    .option("--contributor", "Show source contributor setup")
    .description("Show the read-only first-five-minutes setup checklist")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean; contributor?: boolean }) => {
      printSetupChecklist(options);
    });

program
    .command("mode")
    .description("View or set the current runtime mode (plan or act)")
    .argument("[newMode]", 'Target mode: "plan" or "act"')
    .action((newMode) => {
      if (!newMode) {
        const current = readRuntimeMode();
        console.log(`Current runtime mode: ${current.toUpperCase()}`);
        return;
      }

      if (newMode !== "plan" && newMode !== "act") {
        console.error('Error: Mode must be "plan" or "act"');
        process.exit(1);
      }

      writeRuntimeMode(newMode);
      console.log(`Runtime mode updated to: ${newMode.toUpperCase()}`);
    });

program
    .command("doctor")
    .option("--contributor", "Run repository contributor diagnostics")
    .description(
      "Everyday diagnostic: run Babel workspace health and integrity checks",
    )
    .option("--json", "Emit structured JSON only")
    .option("--strict", "Treat warnings as fatal in the overall result")
    .option(
      "--strict-enterprise",
      "Require explicit managed enterprise policy controls",
    )
    .option("--verbose", "Include additional diagnostic details")
    .option(
      "--repair-pointers",
      "Remove stale runs/.latest*.json pointers before evidence checks",
    )
    .option(
      "--scope <scope>",
      "Check scope: all | env | workspace | repos | export | enterprise",
      "all",
    )
    .option("--skills", "Run Skill Forge checks")
    .addHelpText(
      "after",
      `
Examples:
  $ babel doctor
  $ babel doctor --scope env --json --verbose
  $ babel doctor --scope repos
  $ babel doctor --scope enterprise --strict-enterprise
  $ babel doctor --scope export --strict
  $ babel doctor --json
`,
    )
    .action(
      async (options: {
        json?: boolean;
        strict?: boolean;
        strictEnterprise?: boolean;
        verbose?: boolean;
        repairPointers?: boolean;
        scope?: string;
        skills?: boolean;
        contributor?: boolean;
      }) => {
        validateRuntimeEnvForCommand({ json: options.json === true });

        if (resolveRuntimePaths().isInstalled && !options.contributor) {
          const report = runInstalledDoctor({ strict: options.strict === true });
          printJsonOrHuman(report, report.checks.map(check => `${check.status}: ${check.id} — ${check.message}`).join("\n"), options.json === true);
          if (report.status === "fail") process.exitCode = 1;
          return;
        }

        if (options.skills === true) {
          const report = runSkillDoctor(BABEL_ROOT);
          printJsonOrHuman(
            report,
            formatSkillDoctorHuman(report),
            options.json === true,
          );
          if (report.status === "fail") {
            process.exit(1);
          }
          return;
        }

        const scope = (options.scope ?? "all") as DoctorScope;
        if (
          ![
            "all",
            "env",
            "workspace",
            "repos",
            "export",
            "enterprise",
          ].includes(scope)
        ) {
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  status: "fail",
                  error: `[babel] Invalid doctor scope "${options.scope}". Valid values: all, env, workspace, repos, export, enterprise`,
                },
                null,
                2,
              )}\n`,
            );
          } else {
            console.error(
              `[babel] Invalid doctor scope "${options.scope}". Valid values: all, env, workspace, repos, export, enterprise`,
            );
          }
          process.exit(1);
        }

        try {
          const result = await runDoctor({
            babelRoot: BABEL_ROOT,
            strict: options.strict === true,
            strictEnterprise: options.strictEnterprise === true,
            verbose: options.verbose === true,
            repairPointers: options.repairPointers === true,
            scope,
          });

          if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            console.log(formatDoctorHuman(result, options.verbose === true));
          }

          if (result.status === "fail") {
            process.exit(1);
          }
        } catch (err: unknown) {
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  status: "fail",
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              )}\n`,
            );
          } else {
            console.error(
              `Doctor check failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          process.exit(1);
        }
      },
    );

registerMaintenanceCommands(program);

registerSkillCommands(program);

program
    .command("shadow-diff")
    .description(
      "Compare the current dry-run shadow root with the live project",
    )
    .option(
      "-p, --project <name>",
      "Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite | example_game_suite | example_game_workspace)",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ babel shadow-diff
  $ babel shadow-diff --project example_saas_backend

Notes:
  - Requires BABEL_SHADOW_ROOT to be set.
  - Uses "git diff --no-index" to compare the directories.
`,
    )
    .action(async (options: { project?: string }) => {
      let projectRoot = process.env["BABEL_PROJECT_ROOT"] ?? process.cwd();

      if (options.project) {
        const resolved = resolveProjectRoot(options.project);
        if (resolved) {
          projectRoot = resolved;
        } else {
          console.warn(
            `Could not find project "${options.project}". Using the current directory instead.`,
          );
        }
      }

      const shadowRoot = process.env["BABEL_SHADOW_ROOT"];

      if (!shadowRoot) {
        console.error(
          'Dry-run shadowing is not active. Run "babel dry on" to enable it.',
        );
        process.exit(1);
      }

      const result = getShadowDiff(shadowRoot, projectRoot);
      if (result.status === "error") {
        console.error(`Could not compare file differences: ${result.error}`);
        process.exit(1);
      }

      if (result.diff) {
        process.stdout.write(result.diff + "\n");
      }
    });

const dryCommand = program
    .command("dry")
    .description(
      "Everyday safety toggle: control persisted dry-run mode for the local CLI",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ babel dry status --json
  $ babel dry on
  $ babel dry off --json

Notes:
  - Dry mode ON keeps mutating tools in dry-run mode.
  - Dry mode OFF enables live mutating tools, but they still run through Babel sandbox protections.
`,
    )
    .action(async () => {
      handleDryMode("status", {});
    });

addDryModeOptions(
    dryCommand
      .command("status")
      .description("Show current dry-run mode state")
      .action(async (options: { json?: boolean }) => {
        handleDryMode("status", options);
      }),
  );

addDryModeOptions(
    dryCommand
      .command("on")
      .description("Persist dry-run mode as on")
      .action(async (options: { json?: boolean }) => {
        handleDryMode("on", options);
      }),
  );

addDryModeOptions(
    dryCommand
      .command("off")
      .description("Persist dry-run mode as off")
      .action(async (options: { json?: boolean }) => {
        handleDryMode("off", options);
      }),
  );

program
    .command("permissions")
    .description(
      "View or set approval/autonomy profile (suggest | auto-edit | full-auto)",
    )
    .argument(
      "[profile]",
      "Approval profile: status | suggest | auto-edit | full-auto",
    )
    .option("--json", "Emit structured JSON only")
    .addHelpText(
      "after",
      `
Examples:
  $ babel permissions
  $ babel permissions suggest
  $ babel permissions auto-edit --json

Notes:
  - suggest maps to plan mode plus dry-run.
  - auto-edit maps to act mode with live sandboxed edits.
  - full-auto keeps sandbox/policy gates but records the highest-autonomy intent.
`,
    )
    .action((profileArg: string | undefined, options: { json?: boolean }) => {
      handlePermissionsCommand(profileArg, options);
    });
}
