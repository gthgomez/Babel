import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Command } from "commander";
import { registerInspectTuiCommand } from "./inspectTuiCommands.js";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { buildCausalAttributionReport, formatCausalAttributionHuman } from "../services/causalAttribution.js";
import { buildInspectManifestView, buildInspectOutcomeView, buildInspectRunView, buildInspectStackView, buildInspectSummaryView, loadInspectBundle, resolveInspectRunDir } from "../inspect/loaders.js";
import { renderInspectManifest, renderInspectOutcome, renderInspectRun, renderInspectStack, renderInspectSummary } from "../ui/inspection.js";
import { formatSessionRunValidatorText, validateSessionRun } from "../agent/sessionRunValidator.js";
import { inspectSessionEventLogFromDir } from "../agent/sessionEvents.js";
import { getExecutorToolRegistrySnapshot, getExecutorToolSnapshot } from "../localTools.js";
import type { ExecutorToolSnapshot } from "../tools/executorRegistry.js";
import { buildToolCatalog, formatToolCatalogHuman } from "../tools/toolCatalog.js";
import { BABEL_RUNS_DIR } from "../cli/constants.js";
import { formatBdnsDiagnosticHuman, loadBdnsDiagnosticBundle } from "../diagnostics/bdns/reader.js";
import { readAcceptanceArtifacts } from "../acceptance/recording.js";
import { readLatestRunPointer } from "../cli/helpers.js";
import { detectContextFingerprintDrift, readExecutorSessionContext, summarizeExecutorSessionContext } from "../services/sessionContext.js";
import { handleProofReport, resolveProofRunArg, resolveProofRunDir, resolveRunForReadOnlyCommand } from './coreCommandSupport.js';

function parseToolList(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function printExecutorToolList(options: {
  json?: boolean;
  policy?: boolean;
  whyDisabled?: boolean;
  capabilities?: boolean;
  executionProfile?: string;
  allowedTools?: string;
  disallowedTools?: string;
}): void {
  const tools = getExecutorToolRegistrySnapshot();
  const showCatalog =
    options.policy === true ||
    options.whyDisabled === true ||
    options.capabilities === true;
  const catalog = showCatalog
    ? buildToolCatalog(tools, {
        executionProfile: options.executionProfile,
        allowedTools: parseToolList(options.allowedTools),
        disallowedTools: parseToolList(options.disallowedTools),
        includeCapabilities: options.capabilities === true,
      })
    : [];

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "ok",
          count: tools.length,
          tools,
          ...(showCatalog
            ? {
                execution_profile:
                  options.executionProfile ??
                  process.env["BABEL_EXECUTION_PROFILE"] ??
                  "safe_repo",
                catalog,
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (showCatalog) {
    console.log(formatToolCatalogHuman(catalog));
    return;
  }

  console.log("Executor tool registry:");
  for (const tool of tools) {
    const safety = tool.mutating ? "mutating" : "read-only";
    console.log(
      `  ${tool.name.padEnd(16)} ${tool.category.padEnd(12)} ${safety.padEnd(9)} ${tool.description}`,
    );
  }
}

function printExecutorToolInspect(
  tool: ExecutorToolSnapshot,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "ok", tool }, null, 2)}\n`,
    );
    return;
  }

  console.log(`Tool: ${tool.name}`);
  console.log(`  Category: ${tool.category}`);
  console.log(`  Mutating: ${tool.mutating ? "yes" : "no"}`);
  console.log(`  Dry run:  ${tool.dryRunBehavior}`);
  console.log(
    `  Required: ${tool.input.required.length > 0 ? tool.input.required.join(", ") : "(none)"}`,
  );
  console.log(
    `  Optional: ${tool.input.optional.length > 0 ? tool.input.optional.join(", ") : "(none)"}`,
  );
  console.log(`  Policy:   ${tool.policyTags.join(", ")}`);
  console.log(`  ${tool.description}`);
}

function handleExecutorToolInspect(
  name: string,
  options: { json?: boolean; policy?: boolean; executionProfile?: string },
): void {
  const tool = getExecutorToolSnapshot(name);
  if (!tool) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "not_found",
            tool: name,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(
        `Unknown tool "${name}". Run "babel tools list" to see available tools.`,
      );
    }
    process.exit(1);
  }

  if (options.policy === true) {
    const catalogEntry = buildToolCatalog([tool], {
      executionProfile: options.executionProfile,
    })[0];
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ status: "ok", tool, catalog_entry: catalogEntry }, null, 2)}\n`,
      );
      return;
    }
    console.log(formatToolCatalogHuman(catalogEntry ? [catalogEntry] : []));
    return;
  }

  printExecutorToolInspect(tool, options.json === true);
}

interface SessionSummary {
  run_dir: string;
  run_id: string;
  project: string | null;
  task: string | null;
  status: string | null;
  updated_at: string | null;
}

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSessionSummary(runDir: string): SessionSummary {
  const manifest = safeReadJson(join(runDir, "01_manifest.json"));
  const runtimeTelemetry = safeReadJson(
    join(runDir, "06_runtime_telemetry.json"),
  );
  const executionReport = safeReadJson(
    join(runDir, "04_execution_report.json"),
  );
  const stats = existsSync(runDir) ? statSync(runDir) : null;

  return {
    run_dir: runDir,
    run_id: basename(runDir),
    project: getStringField(manifest, "target_project"),
    task:
      getStringField(manifest, "task_summary") ??
      getStringField(manifest, "user_request"),
    status:
      getStringField(runtimeTelemetry, "final_outcome") ??
      getStringField(executionReport, "status"),
    updated_at: stats ? stats.mtime.toISOString() : null,
  };
}

function listSessionSummaries(options: {
  project?: string;
  limit?: number;
}): SessionSummary[] {
  if (!existsSync(BABEL_RUNS_DIR)) {
    return [];
  }

  return readdirSync(BABEL_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(BABEL_RUNS_DIR, entry.name))
    .filter((runDir) => existsSync(join(runDir, "01_manifest.json")))
    .map(readSessionSummary)
    .sort((left, right) =>
      String(right.updated_at ?? "").localeCompare(
        String(left.updated_at ?? ""),
      ),
    )
    .filter(
      (summary) => !options.project || summary.project === options.project,
    )
    .slice(0, options.limit ?? 10);
}

function printSessionSummary(summary: SessionSummary, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "ok", session: summary }, null, 2)}\n`,
    );
    return;
  }

  console.log("Latest Babel session:");
  console.log(`  Run:     ${summary.run_dir}`);
  console.log(`  Project: ${summary.project ?? "(unknown)"}`);
  console.log(`  Status:  ${summary.status ?? "(unknown)"}`);
  console.log(`  Task:    ${summary.task ?? "(unknown)"}`);
}

function printSessionList(sessions: SessionSummary[], json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "ok", count: sessions.length, sessions }, null, 2)}\n`,
    );
    return;
  }

  if (sessions.length === 0) {
    console.log("No Babel sessions found.");
    return;
  }

  console.log("Recent Babel sessions:");
  for (const session of sessions) {
    console.log(`  ${session.run_id}`);
    console.log(`    Project: ${session.project ?? "(unknown)"}`);
    console.log(`    Status:  ${session.status ?? "(unknown)"}`);
    console.log(`    Run:     ${session.run_dir}`);
  }
}

function addInspectCommonOptions(command: Command): Command {
  return command
    .option("--run <run>", "Run directory or latest")
    .option("--project <name>", "Filter latest run pointer by project");
}

function renderInspectView(
  kind: "run" | "summary" | "stack" | "manifest" | "outcome",
  runDir: string,
): string {
  const bundle = loadInspectBundle(runDir);
  switch (kind) {
    case "run":
      return renderInspectRun(buildInspectRunView(bundle));
    case "summary":
      return renderInspectSummary(buildInspectSummaryView(bundle));
    case "stack":
      return renderInspectStack(buildInspectStackView(bundle));
    case "manifest":
      return renderInspectManifest(buildInspectManifestView(bundle));
    case "outcome":
      return renderInspectOutcome(buildInspectOutcomeView(bundle));
  }
}

function handleInspectMode(
  kind: "run" | "summary" | "stack" | "manifest" | "outcome",
  runArg: string | undefined,
  options: { run?: string; project?: string },
): void {
  try {
    const resolvedRunDir = resolveInspectRunDir({
      run: options.run ?? runArg,
      project: options.project,
      babelRunsDir: BABEL_RUNS_DIR,
    });
    process.stdout.write(`${renderInspectView(kind, resolvedRunDir)}\n`);
  } catch (err: unknown) {
    console.error(
      `Error during inspection: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

function handleWhyInspection(
  runArg: string | undefined,
  options: { run?: string; project?: string; json?: boolean },
): void {
  try {
    const runDir = resolveInspectRunDir({
      run: options.run ?? runArg ?? "latest",
      project: options.project,
      babelRunsDir: BABEL_RUNS_DIR,
    });
    const loaded = inspectSessionEventLogFromDir(runDir);
    const report = buildCausalAttributionReport({
      runDir,
      log: loaded.kind === "valid" ? loaded.log : null,
      ...(loaded.kind === "invalid" ? { loadError: loaded.error.message } : {}),
      ...(loaded.kind === "missing"
        ? { loadError: `session event log missing at ${loaded.path}` }
        : {}),
    });
    printJsonOrHuman(
      report,
      formatCausalAttributionHuman(report),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

function printSessionResume(
  runArg: string | undefined,
  options: { project?: string; json?: boolean },
): void {
  try {
    const runDir = resolveRunForReadOnlyCommand(runArg, options.project);
    const sessionSummary = readSessionSummary(runDir);
    const context = readExecutorSessionContext(runDir);
    const payload = {
      status: "ok",
      run_dir: runDir,
      session: sessionSummary,
      model_context: summarizeExecutorSessionContext(context),
      context_drift: context?.context_fingerprint
        ? detectContextFingerprintDrift(
            context.context_fingerprint,
            context.model_context.next_turn_prompt,
          )
        : null,
      recovery_commands: [
        `babel inspect run ${runDir}`,
        `babel checkpoint list --run ${runDir} --json`,
        `babel session resume ${runDir} --json`,
      ],
    };
    const humanLines = [
      "Babel Session Resume",
      `Run: ${runDir}`,
      `Status: ${sessionSummary.status ?? "unknown"}`,
      `Model context: ${payload.model_context.available ? "available" : "not available"}`,
    ];
    if (payload.context_drift) {
      humanLines.push(`Context fingerprint: ${payload.context_drift.message}`);
    }
    printJsonOrHuman(payload, humanLines.join("\n"), options.json === true);
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

export function registerCoreInspectionCommands(program: Command): void {
const toolsCommand = program
    .command("tools")
    .description("Inspect the executor tool registry")
    .addHelpText(
      "after",
      `
Examples:
  $ babel tools list
  $ babel tools list --json
  $ babel tools list --policy --capabilities
  $ babel tools list --policy --allowed-tools file_read,directory_list
  $ babel tools inspect file_read
  $ babel tools inspect shell_exec --policy --json

Notes:
  - This is an inspection surface for executor capabilities, not a tool execution surface.
  - Use babel run --allowed-tools / --disallowed-tools to scope tools for a run.
`,
    )
    .action(() => {
      printExecutorToolList({});
    });

toolsCommand
    .command("list")
    .description("List registered executor tools")
    .option("--json", "Emit structured JSON only")
    .option("--policy", "Include current policy decision for each tool")
    .option(
      "--why-disabled",
      "Alias for --policy that emphasizes disabled reasons",
    )
    .option(
      "--capabilities",
      "Include capability broker entries such as archive and bundle inspection",
    )
    .option(
      "--execution-profile <profile>",
      "Evaluate policy/capabilities for an execution profile",
    )
    .option(
      "--allowed-tools <tools>",
      "Comma-separated run-level allowed tool names to simulate",
    )
    .option(
      "--disallowed-tools <tools>",
      "Comma-separated run-level disallowed tool names to simulate",
    )
    .action(
      (options: {
        json?: boolean;
        policy?: boolean;
        whyDisabled?: boolean;
        capabilities?: boolean;
        executionProfile?: string;
        allowedTools?: string;
        disallowedTools?: string;
      }) => {
        printExecutorToolList(options);
      },
    );

toolsCommand
    .command("inspect")
    .description("Inspect one registered executor tool")
    .argument("<name>", "Executor tool name")
    .option("--json", "Emit structured JSON only")
    .option("--policy", "Include current policy decision for this tool")
    .option(
      "--execution-profile <profile>",
      "Evaluate policy for an execution profile",
    )
    .action(
      (
        name: string,
        options: {
          json?: boolean;
          policy?: boolean;
          executionProfile?: string;
        },
      ) => {
        handleExecutorToolInspect(name, options);
      },
    );

const sessionCommand = program
    .command("session")
    .description("Read-only session views backed by Babel run evidence")
    .addHelpText(
      "after",
      `
Examples:
  $ babel session latest
  $ babel session latest --project example_saas_backend --json
  $ babel session list --limit 5
  $ babel session inspect latest

Notes:
  - Sessions are evidence-backed run directories, not separate chat logs.
  - "latest" uses the same project-scoped latest pointer as inspect/evidence.
`,
    )
    .action(() => {
      const latest = readLatestRunPointer();
      if (!latest) {
        console.error("[babel] No latest session pointer found.");
        process.exit(1);
      }
      printSessionSummary(readSessionSummary(latest.run_dir), false);
    });

sessionCommand
    .command("latest")
    .description("Show the latest evidence-backed session")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--json", "Emit structured JSON only")
    .action((options: { project?: string; json?: boolean }) => {
      const latest = readLatestRunPointer(options.project);
      if (!latest) {
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: "no_latest_session",
                project: options.project ?? null,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          console.error(
            `[babel] No latest session pointer found${options.project ? ` for ${options.project}` : ""}.`,
          );
        }
        process.exit(1);
      }
      printSessionSummary(
        readSessionSummary(latest.run_dir),
        options.json === true,
      );
    });

sessionCommand
    .command("list")
    .description("List recent evidence-backed sessions")
    .option("--project <name>", "Filter by manifest target project")
    .option("--limit <n>", "Maximum sessions to show", "10")
    .option("--json", "Emit structured JSON only")
    .action((options: { project?: string; limit?: string; json?: boolean }) => {
      const limit = Number.parseInt(options.limit ?? "10", 10);
      const sessions = listSessionSummaries({
        ...(options.project !== undefined ? { project: options.project } : {}),
        limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
      });
      printSessionList(sessions, options.json === true);
    });

sessionCommand
    .command("resume")
    .description("Resolve a run id/latest pointer into recovery metadata")
    .argument("[run]", "Run directory or latest", "latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        runArg: string | undefined,
        options: { project?: string; json?: boolean },
      ) => {
        printSessionResume(runArg, options);
      },
    );

sessionCommand
    .command("inspect")
    .description(
      "Inspect a session summary via existing evidence-bundle inspection",
    )
    .argument("[run]", "Run directory or latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .action((runArg: string | undefined, options: { project?: string }) => {
      handleInspectMode("summary", runArg ?? "latest", options);
    });

const inspectCommand = program
    .command("inspect")
    .description(
      "Read-only run inspection surfaces for existing Babel evidence bundles",
    )
    .option("--last", "Use latest run pointer")
    .option(
      "--report",
      "Generate proof_status.json and BABEL_RUN_REPORT.md for a run",
    )
    .option(
      "--why",
      "Derive evidence-backed failure attribution from session events",
    )
    .option("--run <run>", "Run directory or latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--json", "Emit structured JSON only")
    .addHelpText(
      "after",
      `
Examples:
  $ babel inspect --last --report
  $ babel inspect report latest
  $ babel inspect run latest
  $ babel inspect summary --run latest
  $ babel inspect stack --run <run_dir>
  $ babel inspect validate-run chat-<session-id>
  $ babel inspect tui latest
  $ babel inspect tui --view screen

Notes:
  - These views are read-only and operate on already-created evidence bundles.
  - --report writes proof_status.json and BABEL_RUN_REPORT.md into the run directory.
`,
    )
    .action(
      async (options: {
        last?: boolean;
        report?: boolean;
        why?: boolean;
        run?: string;
        project?: string;
        json?: boolean;
      }) => {
        if (options.report === true) {
          handleProofReport(undefined, options);
          return;
        }
        if (options.why === true) {
          handleWhyInspection(undefined, options);
          return;
        }
        inspectCommand.help({ error: false });
      },
    );

addInspectCommonOptions(
    inspectCommand
      .command("report")
      .argument("[run]", "Run directory or latest")
      .description(
        "Generate proof_status.json and BABEL_RUN_REPORT.md for a Babel run",
      )
      .option("--last", "Use latest run pointer")
      .option("--json", "Emit structured JSON only")
      .action(
        async (
          runArg: string | undefined,
          options: {
            run?: string;
            project?: string;
            last?: boolean;
            json?: boolean;
          },
        ) => {
          handleProofReport(runArg, options);
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("why")
      .argument("[run]", "Run directory or latest")
      .description(
        "Derive evidence-backed failure attribution without assigning unsupported model blame",
      )
      .option("--json", "Emit structured JSON only")
      .action(
        (
          runArg: string | undefined,
          options: { run?: string; project?: string; json?: boolean },
          command: Command,
        ) => {
          handleWhyInspection(runArg, {
            ...options,
            json:
              options.json === true ||
              command.opts().json === true ||
              command.parent?.opts().json === true,
          });
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("run")
      .argument("[run]", "Run directory or latest")
      .description("Inspect a complete Babel run bundle")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string },
        ) => {
          handleInspectMode("run", runArg, options);
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("summary")
      .argument("[run]", "Run directory or latest")
      .description("Inspect the summary artifact for a Babel run")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string },
        ) => {
          handleInspectMode("summary", runArg, options);
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("bdns")
      .argument("[run]", "Run directory or latest")
      .description("Inspect bounded BDNS evidence for a run")
      .option("--json", "Emit structured JSON only")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string; json?: boolean },
        ) => {
          const runDir = resolveInspectRunDir({
            run: options.run ?? runArg ?? "latest",
            project: options.project,
            babelRunsDir: BABEL_RUNS_DIR,
          });
          const bundle = await loadBdnsDiagnosticBundle(runDir);
          printJsonOrHuman(
            bundle,
            formatBdnsDiagnosticHuman(bundle),
            options.json === true,
          );
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("acceptance")
      .argument("[run]", "Run directory or latest")
      .description(
        "Inspect redacted Acceptance V0 recording artifacts for a run",
      )
      .option("--json", "Emit structured JSON only")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string; json?: boolean },
        ) => {
          const runDir = resolveInspectRunDir({
            run: options.run ?? runArg ?? "latest",
            project: options.project,
            babelRunsDir: BABEL_RUNS_DIR,
          });
          const bundle = readAcceptanceArtifacts(runDir);
          if (!bundle) {
            printJsonOrHuman(
              { status: "missing", runDir },
              `No Acceptance V0 recording found for ${runDir}`,
              options.json === true,
            );
            return;
          }
          printJsonOrHuman(
            bundle,
            `Acceptance V0 recording for ${runDir}\n${JSON.stringify(bundle, null, 2)}`,
            options.json === true,
          );
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("stack")
      .argument("[run]", "Run directory or latest")
      .description("Inspect the resolved instruction stack for a Babel run")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string },
        ) => {
          handleInspectMode("stack", runArg, options);
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("manifest")
      .argument("[run]", "Run directory or latest")
      .description("Inspect the artifact manifest for a Babel run")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string },
        ) => {
          handleInspectMode("manifest", runArg, options);
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("outcome")
      .argument("[run]", "Run directory or latest")
      .description("Inspect the derived outcome for a Babel run")
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string },
        ) => {
          handleInspectMode("outcome", runArg, options);
        },
      ),
  );

addInspectCommonOptions(
    inspectCommand
      .command("validate-run")
      .argument("[run]", "Chat session id, run directory, or latest")
      .description(
        "Validate a persisted chat run against the session-event lifecycle contract",
      )
      .option("--json", "Emit structured JSON only")
      .action(
        (
          runArg: string | undefined,
          options: { run?: string; project?: string; json?: boolean },
        ) => {
          try {
            const requested = options.run ?? runArg ?? "latest";
            const result = validateSessionRun(requested, {
              ...(options.project ? { project: options.project } : {}),
            });
            if (options.json) {
              process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
              process.stdout.write(
                `${formatSessionRunValidatorText(result)}\n`,
              );
            }
            if (result.status !== "PASS") process.exitCode = 1;
          } catch (err: unknown) {
            console.error(
              `Error during run validation: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(1);
          }
        },
      ),
  );

registerInspectTuiCommand(inspectCommand);
}
