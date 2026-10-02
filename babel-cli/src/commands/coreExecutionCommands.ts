import { join } from "node:path";
import { Command } from "commander";
import { runBabelPipeline } from "../pipeline.js";
import { type ValidMode } from "../cli/constants.js";
import { parsePositiveIntOption } from './coreCommandSupport.js';



export function registerCoreExecutionCommands(program: Command): void {
// ── Daemon commands (Phase 4A) ──────────────────────────────────────────
  program
    .command("daemon")
    .description("Manage the Babel background daemon")
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.parent?.opts();
      if (!opts?.experimental && !process.env["BABEL_DAEMON_ENABLED"]) {
        console.warn(
          "Note: daemon features are under active development. Use --experimental to suppress this warning.",
        );
      }
    })
    .addCommand(
      new Command("start")
        .description("Start the daemon process (auto-spawns if not running)")
        .action(async () => {
          const { ensureDaemon, pingDaemon } =
            await import("../daemon/client.js");
          try {
            await ensureDaemon();
            const ping = await pingDaemon();
            console.log(
              `Daemon running. PID: ${ping.pid}, Uptime: ${ping.uptime}s`,
            );
          } catch (err: any) {
            console.error(`Failed to start daemon: ${err.message}`);
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command("restart")
        .description("Restart the daemon process")
        .action(async () => {
          const { ipcRequest } = await import("../daemon/ipc.js");
          const { ensureDaemon, pingDaemon } =
            await import("../daemon/client.js");
          try {
            // Graceful shutdown via IPC
            try {
              await ipcRequest("shutdown", undefined, { timeoutMs: 2000 });
              console.log("Previous daemon stopped.");
              // Brief pause to let PID file get cleaned up
              await new Promise((r) => setTimeout(r, 500));
            } catch {
              /* daemon may not be running — that's fine */
            }
            // Auto-spawn a new one
            await ensureDaemon();
            const ping = await pingDaemon();
            console.log(`Daemon restarted. PID: ${ping.pid}`);
          } catch (err: any) {
            console.error(`Failed to restart daemon: ${err.message}`);
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command("stop")
        .description("Stop the daemon process")
        .action(async () => {
          const { stopDaemon } = await import("../daemon.js");
          stopDaemon();
        }),
    )
    .addCommand(
      new Command("status")
        .description("Show daemon status")
        .option("--json", "Emit structured JSON only")
        .action(async (options: { json?: boolean }) => {
          const { getDaemonStatus } = await import("../daemon.js");
          const status = getDaemonStatus();
          if (options.json) {
            console.log(JSON.stringify(status, null, 2));
          } else {
            console.log(`Daemon: ${status.running ? "RUNNING" : "STOPPED"}`);
            if (status.running) {
              console.log(`  PID: ${status.pid}`);
              console.log(
                `  Uptime: ${Math.floor(status.uptime / 60)}m ${status.uptime % 60}s`,
              );
              console.log(`  Queue: ${status.queueSize} tasks`);
              console.log(`  Active: ${status.activeTask ?? "(idle)"}`);
            }
          }
        }),
    );

// ── Headless execution (Phase 4B) ───────────────────────────────────────
  program
    .command("exec")
    .description(
      "Execute a task in headless/CI mode (non-interactive, JSON output)",
    )
    .argument("<task...>", "Task description")
    .option("--project <name>", "Target project")
    .option(
      "--mode <mode>",
      "Pipeline mode: deep (or chat | chat-headless | plan)",
      "deep",
    )
    .option("--background", "Enqueue as background task via daemon")
    .option("--budget <tokens>", "Token budget ceiling")
    .option(
      "--reasoning-effort <level>",
      "Model reasoning effort: low | medium | high",
    )
    .option("--json", "Emit structured JSON only")
    .action(
      async (
        taskParts: string[],
        options: {
          project?: string;
          mode?: string;
          background?: boolean;
          budget?: string;
          reasoningEffort?: string;
          json?: boolean;
        },
      ) => {
        try {
          const task = taskParts.join(" ");

          if (options.background) {
            const { ensureDaemon, pingDaemon } =
              await import("../daemon/client.js");
            const { ipcRequest } = await import("../daemon/ipc.js");

            // Auto-spawn daemon if not running
            try {
              await ensureDaemon();
            } catch (err: any) {
              console.error(
                `Cannot enqueue background task: daemon is not running and could not be started.`,
              );
              console.error(`  ${err.message}`);
              console.error(`  Start the daemon manually: babel daemon start`);
              process.exit(1);
            }

            // Enqueue via IPC
            const result = (await ipcRequest("queue.enqueue", {
              task,
              mode: options.mode ?? "deep",
              projectRoot: options.project ?? null,
            })) as { job_id: string; status: string };

            if (options.json) {
              console.log(
                JSON.stringify(
                  {
                    status: "queued",
                    job_id: result.job_id,
                    job_status: result.status,
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(`Job queued: ${result.job_id}`);
              console.log(`Check status: babel daemon status`);
            }
            return;
          }

          const { runBabelPipeline } = await import("../pipeline.js");
          process.env["BABEL_HEADLESS"] = "true";
          if (options.budget)
            process.env["BABEL_TOKEN_BUDGET"] = options.budget;

          if (options.reasoningEffort !== undefined) {
            const effort = options.reasoningEffort.toLowerCase();
            if (effort === "low" || effort === "medium" || effort === "high") {
              process.env["BABEL_REASONING_EFFORT"] = effort;
            }
          }

          const result = await runBabelPipeline(task, {
            mode: (options.mode as ValidMode) ?? "deep",
            ...(options.project ? { project: options.project } : {}),
          });

          if (options.json) {
            console.log(
              JSON.stringify(
                { status: result.status, runDir: result.runDir },
                null,
                2,
              ),
            );
          } else {
            console.log(`Status: ${result.status}`);
            console.log(`Run: ${result.runDir}`);
          }

          const exitCode =
            result.status === "COMPLETE" ||
            result.status === "COMPLETE_NO_MODIFICATION" ||
            result.status === "SMALL_FIX_COMPLETE" ||
            result.status === "READ_ONLY_MODE_NO_EXECUTOR"
              ? 0
              : result.status === "QA_REJECTED_MAX_LOOPS"
                ? 2
                : result.status === "EXECUTOR_HALTED"
                  ? 1
                  : 3;
          process.exit(exitCode);
        } catch (error: any) {
          console.error(JSON.stringify({ error: error.message }));
          process.exit(3);
        }
      },
    );

// ── Goal loop (P1.1 — experimental) ────────────────────────────────────
  program
    .command("goal")
    .description("Run an autonomous goal loop (experimental)")
    .argument("<goal...>", "Goal description")
    .option("--max-iterations <n>", "Maximum iterations (default: 5)", "5")
    .option("--budget <tokens>", "Token budget ceiling")
    .option(
      "--mode <mode>",
      "Pipeline mode: deep (or chat | chat-headless | plan)",
      "deep",
    )
    .option("--project <name>", "Target project")
    .option("--json", "Emit structured JSON only")
    .action(
      async (
        goalParts: string[],
        options: {
          maxIterations?: string;
          budget?: string;
          mode?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        try {
          if (
            !program.opts().experimental &&
            !process.env["BABEL_DAEMON_ENABLED"]
          ) {
            console.error("babel goal requires --experimental.");
            process.exit(1);
          }

          const goal = goalParts.join(" ");
          const { runGoalLoop } = await import("../services/goalLoop.js");

          const result = await runGoalLoop(goal, {
            maxIterations: parsePositiveIntOption(options.maxIterations, 5),
            ...(options.budget
              ? { tokenBudget: parseInt(options.budget, 10) }
              : {}),
            mode: (options.mode as ValidMode) ?? "deep",
            ...(options.project ? { project: options.project } : {}),
          });

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Goal: ${result.goal}`);
            console.log(`Status: ${result.status}`);
            console.log(`Iterations: ${result.iterations.length}`);
            for (const it of result.iterations) {
              const icon =
                it.status === "COMPLETE" ||
                it.status === "COMPLETE_NO_MODIFICATION" ||
                it.status === "SMALL_FIX_COMPLETE"
                  ? "✅"
                  : it.status === "QA_REJECTED_MAX_LOOPS" ||
                      it.status === "EXECUTOR_HALTED"
                    ? "❌"
                    : "⏭️";
              console.log(
                `  ${icon} #${it.iteration}: ${it.status} — ${it.summary}`,
              );
            }
            if (result.finalRunDir) {
              console.log(`\nFinal run: ${result.finalRunDir}`);
              console.log(`Inspect: babel inspect run ${result.finalRunDir}`);
            }
          }

          process.exit(result.status === "goal_met" ? 0 : 1);
        } catch (error: any) {
          console.error(JSON.stringify({ error: error.message }));
          process.exit(3);
        }
      },
    );
}
