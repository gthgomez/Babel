import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { runBabelPipeline } from "../pipeline.js";




export function registerCoreMemoryPlanCommands(program: Command): void {
// ── Memory management commands ──────────────────────────────────────────
  const memoryCommand = program
    .command("memory")
    .description("Manage persistent project memories from Babel runs")
    .action(() => {
      memoryCommand.help({ error: false });
    });

memoryCommand
    .command("list")
    .description("List all project memories")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--json", "Emit structured JSON only")
    .action(async (options: { projectRoot?: string; json?: boolean }) => {
      const { readProjectMemories } =
        await import("../services/memoryExtraction.js");
      const entries = readProjectMemories(options.projectRoot);
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        if (entries.length === 0) {
          console.log("No project memories found.");
          return;
        }
        const now = new Date();
        for (const entry of entries) {
          const age = Math.floor(
            (now.getTime() - new Date(entry.date).getTime()) / 86_400_000,
          );
          const stale = age > (entry.staleDays || 30) ? " [STALE]" : "";
          console.log(
            `[${entry.date}] ${entry.topic} (${entry.impact})${stale}`,
          );
          console.log(
            `  ${entry.content.slice(0, 120)}${entry.content.length > 120 ? "..." : ""}\n`,
          );
        }
      }
    });

memoryCommand
    .command("query")
    .description("Search project memories by keyword")
    .argument("<term>", "Search term")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--json", "Emit structured JSON only")
    .action(
      async (
        term: string,
        options: { projectRoot?: string; json?: boolean },
      ) => {
        const { queryMemories } =
          await import("../services/memoryExtraction.js");
        const results = queryMemories(options.projectRoot, term);
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log(`No memories match "${term}".`);
            return;
          }
          for (const entry of results) {
            console.log(`[${entry.date}] ${entry.topic} (${entry.impact})`);
            console.log(
              `  ${entry.content.slice(0, 200)}${entry.content.length > 200 ? "..." : ""}\n`,
            );
          }
        }
      },
    );

memoryCommand
    .command("prune")
    .description("Remove stale memories older than N days")
    .option("--max-age <days>", "Maximum age in days", "30")
    .option("--project-root <path>", "Project root", process.cwd())
    .action(async (options: { maxAge?: string; projectRoot?: string }) => {
      const { pruneStaleMemories } =
        await import("../services/memoryExtraction.js");
      const maxAge = Number.parseInt(options.maxAge ?? "30", 10) || 30;
      const pruned = pruneStaleMemories(options.projectRoot, maxAge);
      console.log(
        pruned > 0
          ? `Pruned ${pruned} stale memories (older than ${maxAge} days).`
          : "No stale memories to prune.",
      );
    });

memoryCommand
    .command("log")
    .description("Write a daily log entry for the current session")
    .argument("<summary...>", "Summary of today work")
    .option("--project-root <path>", "Project root", process.cwd())
    .action(
      async (summaryParts: string[], options: { projectRoot?: string }) => {
        const { writeDailyLog } =
          await import("../services/memoryExtraction.js");
        const summary = summaryParts.join(" ");
        writeDailyLog(options.projectRoot, summary);
        console.log("Daily log entry written.");
      },
    );

// ── File history commands ────────────────────────────────────────────────
  const historyCommand = program
    .command("history")
    .description("Show file change history from Babel runs")
    .action(() => {
      historyCommand.help({ error: false });
    });

historyCommand
    .command("file")
    .description("Show which runs touched a specific file")
    .argument("<path>", "File path relative to project root")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--json", "Emit structured JSON only")
    .action(
      async (
        filePath: string,
        options: { projectRoot?: string; json?: boolean },
      ) => {
        const { getFileHistory } = await import("../services/fileHistory.js");
        const results = getFileHistory(filePath, options.projectRoot);
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log(`No history found for "${filePath}".`);
            return;
          }
          for (const history of results) {
            const fileRecord = history.files.find(
              (f) => f.path === filePath || f.path.endsWith(filePath),
            );
            const changed = fileRecord?.changed ? "modified" : "read";
            console.log(
              `[${history.timestamp}] ${history.runId} — ${changed} (${history.files.filter((f) => f.changed).length} files changed total)`,
            );
          }
        }
      },
    );

historyCommand
    .command("task")
    .description("Show files touched by a specific run")
    .argument("<run-id>", "Run ID")
    .option("--project-root <path>", "Project root", process.cwd())
    .option("--json", "Emit structured JSON only")
    .action(
      async (
        runId: string,
        options: { projectRoot?: string; json?: boolean },
      ) => {
        const { getTaskFileHistory } =
          await import("../services/fileHistory.js");
        const history = getTaskFileHistory(runId, options.projectRoot);
        if (options.json) {
          console.log(JSON.stringify(history, null, 2));
        } else {
          if (!history) {
            console.log(`No history found for run "${runId}".`);
            return;
          }
          console.log(`Run: ${history.runId}  [${history.timestamp}]`);
          for (const file of history.files) {
            const status = file.changed ? "CHANGED" : "UNCHANGED";
            console.log(`  ${status}  ${file.path}`);
          }
        }
      },
    );

// ── Plan mode commands ───────────────────────────────────────────────────
  program
    .command("create-plan")
    .description("Create an implementation plan without executing it")
    .argument("<task...>", "Task description")
    .option("--project <name>", "Target project")
    .action(async (taskParts: string[], options: { project?: string }) => {
      try {
        const task = taskParts.join(" ");
        const { runBabelPipeline } = await import("../pipeline.js");
        const pipelineOptions: Record<string, unknown> = { mode: "plan" };
        if (options.project) pipelineOptions["project"] = options.project;
        const result = await runBabelPipeline(task, pipelineOptions as any);
        console.log(`Plan created. Run directory: ${result.runDir}`);
        if (result.manualPromptPath) {
          console.log(`Manual prompt: ${result.manualPromptPath}`);
        }
        console.log(
          `\nNext: review the plan, then run "babel apply-plan ${result.runDir}" to execute.`,
        );
      } catch (error: any) {
        console.error(`Plan creation failed: ${error.message}`);
        process.exit(1);
      }
    });

program
    .command("review-plan")
    .description("Show plan summary from a plan run directory")
    .argument("<plan-dir>", "Plan run directory path")
    .action(async (planDir: string) => {
      try {
        const planPath = join(planDir, "model_plan.json");
        if (!existsSync(planPath)) {
          console.error(`No plan found at ${planPath}`);
          process.exit(1);
        }
        const plan = JSON.parse(readFileSync(planPath, "utf-8")) as Record<
          string,
          unknown
        >;
        console.log(`Plan: ${plan["task_summary"] ?? "Unknown"}`);
        console.log(`Run Dir: ${planDir}`);
        const steps = plan["minimal_action_set"] as
          | Array<Record<string, unknown>>
          | undefined;
        if (steps) {
          console.log(`\nSteps (${steps.length}):`);
          for (const step of steps) {
            console.log(
              `  ${step["step"]}. ${step["tool"]}: ${step["target"]}`,
            );
          }
        }
        const allowed = plan["out_of_scope"] as string[] | undefined;
        if (allowed && allowed.length > 0) {
          console.log(`\nOut of scope: ${allowed.join(", ")}`);
        }
        console.log(
          `\nReview the plan above, then use "babel apply-plan ${planDir}" to execute.`,
        );
      } catch (error: any) {
        console.error(`Plan review failed: ${error.message}`);
        process.exit(1);
      }
    });

program
    .command("apply-plan")
    .description("Execute a saved plan in verified mode")
    .argument("<plan-dir>", "Plan run directory path")
    .option("--lock <files>", "Comma-separated locked files")
    .action(async (planDir: string, options: { lock?: string }) => {
      try {
        const { runBabelPipeline } = await import("../pipeline.js");
        const pipelineOptions: Record<string, unknown> = { mode: "deep" };
        if (options.lock)
          pipelineOptions["lockedFiles"] = options.lock
            .split(",")
            .map((f) => f.trim());
        const result = await runBabelPipeline(planDir, pipelineOptions as any);
        console.log(`Plan applied. Status: ${result.status}`);
        console.log(`Run directory: ${result.runDir}`);
      } catch (error: any) {
        console.error(`Plan application failed: ${error.message}`);
        process.exit(1);
      }
    });
}
