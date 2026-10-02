import { join } from "node:path";
import { Command } from "commander";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { runBabelMcpServer } from "../mcp/server.js";
import { startInteractiveSession } from "../interactive.js";
import { resolveInspectRunDir } from "../inspect/loaders.js";
import { findCheckpoint, formatCheckpointInspect, formatCheckpointList, listCheckpoints, restoreCheckpoint } from "../services/checkpoints.js";
import { getMcpServersConfigPath, readMcpServers, removeMcpServer, upsertMcpServer } from "../config/mcpServers.js";
import { BABEL_RUNS_DIR } from "../cli/constants.js";
import { prepareContextInjection, summarizeContextInjection } from "../services/contextInjection.js";
import { runCiReview, formatCiReviewHuman } from "../services/ciReview.js";
import { buildEventStreamContract } from "../services/eventStream.js";
import { buildIdeBridgeContract, buildIdeBridgeSnapshot, formatIdeBridgeSnapshotHuman } from "../services/ideBridge.js";
import { buildRunStats, formatRunStatsHuman } from "../services/runStats.js";
import { createSchedule, deleteSchedule, formatScheduleListHuman, formatScheduleRunHuman, listSchedules, runScheduleNow, type ScheduleJobType } from "../services/schedules.js";
import { disablePlugin, enablePlugin, formatPluginDoctorHuman, formatPluginInspectHuman, formatPluginListHuman, loadPluginRegistry } from "../services/plugins.js";
import { buildSubagentIsolationContract, formatAgentListHuman, formatAgentMergeHuman, formatAgentMergeRestoreHuman, formatAgentRunHuman, inspectAgentRun, listAgentRuns, mergeAgentRun, restoreAgentMerge, runAgentTeamFromFile } from "../services/agentTeams.js";
import { resolveRunForReadOnlyCommand } from './coreCommandSupport.js';

function printMcpServers(options: { json?: boolean; status?: boolean }): void {
  const servers = readMcpServers();
  const payload = {
    status: "ok",
    config_path: getMcpServersConfigPath(),
    count: Object.keys(servers).length,
    servers,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(
    options.status ? "MCP registry status:" : "Configured MCP servers:",
  );
  console.log(`Config: ${payload.config_path}`);
  for (const [name, server] of Object.entries(servers)) {
    console.log(
      `  ${name.padEnd(16)} ${server.command} ${server.args.join(" ")}`.trimEnd(),
    );
  }
}

export function registerCoreExtensionCommands(program: Command): void {
const checkpointCommand = program
    .command("checkpoint")
    .description("List, inspect, or restore pre-mutation checkpoints")
    .addHelpText(
      "after",
      `
Examples:
  $ babel checkpoint list --run latest
  $ babel checkpoint inspect <checkpoint_id> --run <run_dir>
  $ babel checkpoint restore <checkpoint_id> --run <run_dir> --json
`,
    );

checkpointCommand
    .command("list")
    .description("List checkpoints for a run")
    .option("--run <run>", "Run directory or latest", "latest")
    .option("--project <project>", "Project-scoped latest pointer")
    .option("--json", "Emit structured JSON only")
    .action((options: { run?: string; project?: string; json?: boolean }) => {
      try {
        const runDir = resolveInspectRunDir({
          run: options.run,
          project: options.project,
          babelRunsDir: BABEL_RUNS_DIR,
        });
        const index = listCheckpoints(runDir);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatCheckpointList(index)}\n`);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

checkpointCommand
    .command("inspect")
    .argument("<checkpointId>", "Checkpoint id")
    .description("Inspect a checkpoint record")
    .option("--run <run>", "Run directory or latest")
    .option("--json", "Emit structured JSON only")
    .action(
      (checkpointId: string, options: { run?: string; json?: boolean }) => {
        try {
          const resolved = options.run
            ? findCheckpoint(checkpointId, { runDir: options.run })
            : findCheckpoint(checkpointId, { runsDir: BABEL_RUNS_DIR });
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify(resolved.record, null, 2)}\n`,
            );
          } else {
            process.stdout.write(
              `${formatCheckpointInspect(resolved.record)}\n`,
            );
          }
        } catch (err: unknown) {
          console.error(
            `Checkpoint error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      },
    );

checkpointCommand
    .command("restore")
    .argument("<checkpointId>", "Checkpoint id")
    .description("Restore files captured by a checkpoint")
    .option("--run <run>", "Run directory or latest")
    .option(
      "--force",
      "Restore even if current files differ from the checkpoint post-write state",
    )
    .option("--json", "Emit structured JSON only")
    .action(
      (
        checkpointId: string,
        options: { run?: string; force?: boolean; json?: boolean },
      ) => {
        try {
          const runDir = options.run
            ? resolveInspectRunDir({
                run: options.run,
                babelRunsDir: BABEL_RUNS_DIR,
              })
            : undefined;
          const resolved = runDir
            ? findCheckpoint(checkpointId, { runDir })
            : findCheckpoint(checkpointId, { runsDir: BABEL_RUNS_DIR });
          const result = restoreCheckpoint(resolved.record, {
            force: options.force === true,
          });
          if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          }
          if (result.status !== "restored") {
            process.exit(1);
          }
        } catch (err: unknown) {
          console.error(
            `Checkpoint error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      },
    );

program
    .command("interactive")
    .alias("app")
    .description("Default: enter persistent interactive Babel session (REPL)")
    .option("-p, --project <name>", "Default project for this session")
    .option("--mode <mode>", "Default mode for this session", "chat")
    .option(
      "--resume [sessionId]",
      "Resume a prior session (latest if omitted)",
    )
    .option(
      "--resume-picker",
      "Show the session picker at startup (off by default)",
    )
    .addHelpText(
      "after",
      `
Interactive slash command map:
  /checkpoint, /restore, /session
  /mcp, /plugins, /plugin, /agents
`,
    )
    .action(
      async (options: {
        project?: string;
        mode?: string;
        resume?: string | boolean;
        resumePicker?: boolean;
      }) => {
        try {
          if (options.resumePicker) process.env["BABEL_RESUME_PICKER"] = "1";
          if (options.resume !== undefined) {
            process.env["BABEL_RESUME_SESSION"] =
              options.resume === true || options.resume === ""
                ? "latest"
                : String(options.resume);
          }
          await startInteractiveSession({
            ...(options.project !== undefined
              ? { project: options.project }
              : {}),
            mode: options.mode as never,
          });
        } catch (err: unknown) {
          console.error(
            `Interactive session error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      },
    );

const mcpCommand = program
    .command("mcp")
    .description(
      "Manage MCP server registry or run the Babel MCP control-plane server over stdio",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ babel mcp list
  $ babel mcp add filesystem npx -y @modelcontextprotocol/server-filesystem C:/Workspace
  $ babel mcp remove filesystem
  $ babel mcp serve

Notes:
  - Bare "babel mcp" is kept as a compatibility alias for "babel mcp serve".
`,
    )
    .action(async () => {
      try {
        await runBabelMcpServer();
      } catch (err: unknown) {
        console.error(
          `MCP error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

mcpCommand
    .command("doctor")
    .description(
      "Diagnose MCP registry, transport, auth, timeout, and schema policy",
    )
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const servers = readMcpServers();
      const payload = {
        status: "ok",
        config_path: getMcpServersConfigPath(),
        server_count: Object.keys(servers).length,
        servers,
        transport_policy: {
          supported: ["stdio"],
          http_oauth: "not_enabled",
        },
        auth_policy: {
          env_passthrough: "scrubbed",
          secret_redaction: true,
        },
        timeout_policy: {
          default_ms: Number(process.env["BABEL_MCP_TIMEOUT_MS"] ?? "10000"),
        },
        schema_policy: {
          lazy_loading: true,
          bounded_tool_search: true,
        },
        external_content_policy: {
          resources_are_untrusted: true,
          prompts_are_untrusted: true,
          tools_are_policy_gated: true,
        },
      };
      printJsonOrHuman(
        payload,
        [
          "Babel MCP Doctor",
          `Config: ${payload.config_path}`,
          `Servers: ${payload.server_count}`,
          "Schema policy: lazy loading, bounded tool search",
          "External content policy: MCP content is untrusted",
        ].join("\n"),
        options.json === true,
      );
    });

mcpCommand
    .command("serve")
    .description("Run the read-only Babel MCP control-plane server over stdio")
    .action(async () => {
      try {
        await runBabelMcpServer();
      } catch (err: unknown) {
        console.error(
          `MCP error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

mcpCommand
    .command("list")
    .description("List configured MCP servers")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      printMcpServers(options);
    });

mcpCommand
    .command("status")
    .description("Show MCP registry path and configured server count")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      printMcpServers({ ...options, status: true });
    });

mcpCommand
    .command("add")
    .description("Add or update an MCP server registry entry")
    .argument("<name>", "Logical server name used in mcp_request.server")
    .argument("<command>", "Executable to spawn")
    .argument("[args...]", "Arguments passed to the executable")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        name: string,
        commandValue: string,
        args: string[] | undefined,
        options: { json?: boolean },
      ) => {
        try {
          const servers = upsertMcpServer(name, {
            command: commandValue,
            args: args ?? [],
          });
          const payload = {
            status: "ok",
            action: "upsert",
            name,
            config_path: getMcpServersConfigPath(),
            server: servers[name],
          };
          if (options.json) {
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
          } else {
            console.log(`MCP server "${name}" saved to ${payload.config_path}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({ status: "fail", error: message }, null, 2)}\n`,
            );
          } else {
            console.error(`MCP error: ${message}`);
          }
          process.exit(1);
        }
      },
    );

mcpCommand
    .command("remove")
    .description("Remove an MCP server registry entry")
    .argument("<name>", "Logical server name to remove")
    .option("--json", "Emit structured JSON only")
    .action((name: string, options: { json?: boolean }) => {
      try {
        removeMcpServer(name);
        const payload = {
          status: "ok",
          action: "remove",
          name,
          config_path: getMcpServersConfigPath(),
        };
        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          console.log(
            `MCP server "${name}" removed from ${payload.config_path}`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ status: "fail", error: message }, null, 2)}\n`,
          );
        } else {
          console.error(`MCP error: ${message}`);
        }
        process.exit(1);
      }
    });

const contextCommand = program
    .command("context")
    .description("Preview bounded @file and @directory context attachments")
    .action(() => {
      contextCommand.help({ error: false });
    });

contextCommand
    .command("preview")
    .description("Preview context attachments without starting a run")
    .argument(
      "<refs...>",
      "@file/@directory references, for example: @file README.md",
    )
    .option(
      "--project-root <path>",
      "Project root for attachment resolution",
      process.cwd(),
    )
    .option("--json", "Emit structured JSON only")
    .action(
      (refs: string[], options: { projectRoot?: string; json?: boolean }) => {
        try {
          const task = refs.join(" ");
          const result = prepareContextInjection(task, {
            projectRoot: options.projectRoot ?? process.cwd(),
          });
          printJsonOrHuman(
            result,
            summarizeContextInjection(result),
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

const eventsCommand = program
    .command("events")
    .description("Inspect structured JSON event stream contracts")
    .action(() => {
      eventsCommand.help({ error: false });
    });

eventsCommand
    .command("schema")
    .description("Print the read-only JSONL event stream contract")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const contract = buildEventStreamContract();
      printJsonOrHuman(
        contract,
        JSON.stringify(contract, null, 2),
        options.json === true,
      );
    });

eventsCommand
    .command("ide-bridge")
    .description("Print a read-only IDE bridge snapshot for a run")
    .argument("[run]", "Run directory or latest", "latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--contract-only", "Print only the read-only bridge contract")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        runArg: string | undefined,
        options: { project?: string; contractOnly?: boolean; json?: boolean },
      ) => {
        try {
          if (options.contractOnly === true) {
            const contract = buildIdeBridgeContract();
            printJsonOrHuman(
              contract,
              JSON.stringify(contract, null, 2),
              options.json === true,
            );
            return;
          }
          const runDir = resolveRunForReadOnlyCommand(runArg, options.project);
          const snapshot = buildIdeBridgeSnapshot(runDir);
          printJsonOrHuman(
            snapshot,
            formatIdeBridgeSnapshotHuman(snapshot),
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

const statsCommand = program
    .command("stats")
    .description("Derive stats from existing evidence bundles")
    .action(() => {
      statsCommand.help({ error: false });
    });

statsCommand
    .command("run")
    .description("Derive run stats from an evidence bundle")
    .argument("[run]", "Run directory or latest", "latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        runArg: string | undefined,
        options: { project?: string; json?: boolean },
      ) => {
        try {
          const runDir = resolveRunForReadOnlyCommand(runArg, options.project);
          const stats = buildRunStats(runDir);
          printJsonOrHuman(
            stats,
            formatRunStatsHuman(stats),
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

const pluginsCommand = program
    .command("plugins")
    .description("Inspect and manage runtime plugins behind policy gates")
    .action(() => {
      const registry = loadPluginRegistry();
      process.stdout.write(`${formatPluginListHuman(registry)}\n`);
    });

pluginsCommand
    .command("list")
    .description("List discovered runtime plugins")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const registry = loadPluginRegistry();
      printJsonOrHuman(
        registry,
        formatPluginListHuman(registry),
        options.json === true,
      );
    });

pluginsCommand
    .command("doctor")
    .description("Diagnose runtime plugin manifests and trust gates")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const registry = loadPluginRegistry();
      printJsonOrHuman(
        registry,
        formatPluginDoctorHuman(registry),
        options.json === true,
      );
      if (registry.status === "fail") {
        process.exit(1);
      }
    });

pluginsCommand
    .command("inspect")
    .description("Inspect one plugin")
    .argument("<id>", "Plugin id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      const registry = loadPluginRegistry();
      const plugin = registry.plugins.find((entry) => entry.manifest.id === id);
      if (!plugin) {
        printJsonErrorAndExit(`Plugin not found: ${id}`, options.json === true);
      }
      printJsonOrHuman(
        plugin,
        formatPluginInspectHuman(plugin),
        options.json === true,
      );
    });

pluginsCommand
    .command("enable")
    .description("Enable a plugin id in local plugin config")
    .argument("<id>", "Plugin id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const config = enablePlugin(id);
        printJsonOrHuman(
          { status: "ok", config },
          `Enabled plugin ${id}`,
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

pluginsCommand
    .command("disable")
    .description("Disable a plugin id in local plugin config")
    .argument("<id>", "Plugin id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const config = disablePlugin(id);
        printJsonOrHuman(
          { status: "ok", config },
          `Disabled plugin ${id}`,
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

const agentsCommand = program
    .command("agents")
    .description("Inspect and run spec-contract agent teams")
    .action(() => {
      const index = listAgentRuns();
      process.stdout.write(`${formatAgentListHuman(index)}\n`);
    });

agentsCommand
    .command("list")
    .description("List prior agent-team runs")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const index = listAgentRuns();
      printJsonOrHuman(
        index,
        formatAgentListHuman(index),
        options.json === true,
      );
    });

agentsCommand
    .command("contract")
    .description("Print the live-subagent isolation contract")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const contract = buildSubagentIsolationContract();
      printJsonOrHuman(
        contract,
        JSON.stringify(contract, null, 2),
        options.json === true,
      );
    });

agentsCommand
    .command("run")
    .description("Run an agent-team spec file")
    .argument("<spec>", "Path to agent-team spec JSON")
    .option("--json", "Emit structured JSON only")
    .action((spec: string, options: { json?: boolean }) => {
      try {
        const run = runAgentTeamFromFile(spec);
        printJsonOrHuman(run, formatAgentRunHuman(run), options.json === true);
        if (run.status === "failed") {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

agentsCommand
    .command("inspect")
    .description("Inspect an agent-team run")
    .argument("<idOrPath>", "Agent-team run id or path")
    .option("--json", "Emit structured JSON only")
    .action((idOrPath: string, options: { json?: boolean }) => {
      try {
        const run = inspectAgentRun(idOrPath);
        printJsonOrHuman(run, formatAgentRunHuman(run), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

agentsCommand
    .command("merge")
    .description("Merge a ready agent-team run")
    .argument("<idOrPath>", "Agent-team run id or path")
    .option("--json", "Emit structured JSON only")
    .action((idOrPath: string, options: { json?: boolean }) => {
      try {
        const report = mergeAgentRun(idOrPath);
        printJsonOrHuman(
          report,
          formatAgentMergeHuman(report),
          options.json === true,
        );
        if (report.status === "failed") {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

agentsCommand
    .command("restore")
    .description("Restore files from an agent-team merge pre-merge snapshot")
    .argument("<idOrPath>", "Agent-team run id or path")
    .option("--json", "Emit structured JSON only")
    .action((idOrPath: string, options: { json?: boolean }) => {
      try {
        const report = restoreAgentMerge(idOrPath);
        printJsonOrHuman(
          report,
          formatAgentMergeRestoreHuman(report),
          options.json === true,
        );
        if (report.status === "failed") {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

const scheduleCommand = program
    .command("schedule")
    .description(
      "Manage local schedules; mutating run-now jobs require explicit gates",
    )
    .action(() => {
      const payload = listSchedules();
      process.stdout.write(`${formatScheduleListHuman(payload)}\n`);
    });

scheduleCommand
    .command("list")
    .description("List local schedules")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const payload = listSchedules();
      printJsonOrHuman(
        payload,
        formatScheduleListHuman(payload),
        options.json === true,
      );
    });

scheduleCommand
    .command("create")
    .description("Create a local schedule entry")
    .argument("<id>", "Schedule id")
    .argument("<jobType>", "Job type")
    .option("--project-root <path>", "Project root used by the scheduled job")
    .option("--base-ref <ref>", "Optional base ref for review/draft jobs")
    .option("--branch <name>", "Branch name for git_branch_create")
    .option("--message <message>", "Commit message for git_commit_create")
    .option("--pr-title <title>", "PR title for git_pr_create")
    .option("--pr-body <body>", "PR body for git_pr_create")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        id: string,
        jobType: string,
        options: {
          projectRoot?: string;
          baseRef?: string;
          branch?: string;
          message?: string;
          prTitle?: string;
          prBody?: string;
          json?: boolean;
        },
      ) => {
        try {
          const schedule = createSchedule({
            id,
            jobType: jobType as ScheduleJobType,
            ...(options.projectRoot
              ? { projectRoot: options.projectRoot }
              : {}),
            ...(options.baseRef ? { baseRef: options.baseRef } : {}),
            ...(options.branch ? { branchName: options.branch } : {}),
            ...(options.message ? { commitMessage: options.message } : {}),
            ...(options.prTitle ? { prTitle: options.prTitle } : {}),
            ...(options.prBody ? { prBody: options.prBody } : {}),
          });
          printJsonOrHuman(
            { status: "ok", schedule },
            `Created schedule ${schedule.id}`,
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

scheduleCommand
    .command("run-now")
    .description(
      "Run a schedule immediately; mutating jobs require --allow-mutate and execute in an isolated project copy",
    )
    .argument("<id>", "Schedule id")
    .option(
      "--allow-mutate",
      "Allow mutating scheduled jobs inside an isolated project copy",
    )
    .option("--json", "Emit structured JSON only")
    .addHelpText(
      "after",
      `
Notes:
  - Mutating scheduled jobs require --allow-mutate.
  - Mutating jobs run inside an isolated project copy.
`,
    )
    .action(
      (id: string, options: { allowMutate?: boolean; json?: boolean }) => {
        try {
          const record = runScheduleNow(id, {
            allowMutate: options.allowMutate === true,
          });
          printJsonOrHuman(
            record,
            formatScheduleRunHuman(record),
            options.json === true,
          );
          if (record.status === "fail") {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

scheduleCommand
    .command("delete")
    .description("Delete a local schedule entry")
    .argument("<id>", "Schedule id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      const result = deleteSchedule(id);
      printJsonOrHuman(
        result,
        result.deleted
          ? `Deleted schedule ${id}`
          : `No schedule found for ${id}`,
        options.json === true,
      );
    });

const ciCommand = program
    .command("ci")
    .description("Read-only CI and review evidence surfaces")
    .action(() => {
      ciCommand.help({ error: false });
    });

ciCommand
    .command("review")
    .description("Write deterministic read-only CI review evidence")
    .option("--project-root <path>", "Project root to review", process.cwd())
    .option("--base-ref <ref>", "Optional base ref")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: { projectRoot?: string; baseRef?: string; json?: boolean }) => {
        try {
          const report = runCiReview({
            projectRoot: options.projectRoot ?? process.cwd(),
            ...(options.baseRef ? { baseRef: options.baseRef } : {}),
          });
          printJsonOrHuman(
            report,
            formatCiReviewHuman(report),
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
}
