import { join } from "node:path";
import { Command } from "commander";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { resolveInspectRunDir } from "../inspect/loaders.js";
import { BABEL_RUNS_DIR, VALID_MODES, resolveMode, type ValidMode } from "../cli/constants.js";
import { formatBdnsDiagnosticHuman, loadBdnsDiagnosticBundle } from "../diagnostics/bdns/reader.js";
import { approveAgentJob, createAgentJob, formatAgentJobHuman, formatAgentJobListHuman, getAgentJob, getAgentJobApprovalState, listAgentJobs, pauseAgentJob, resumeAgentJob, updateAgentJob, writeAgentJobReport, type AgentJob } from "../services/agentJobs.js";
import { APPROVAL_STATUSES, approveApproval, denyApproval, formatApprovalHuman, formatApprovalListHuman, inspectApproval, listApprovals, requestDependencyInstallApproval, requestModelEscalationApproval, type ApprovalRecord, type ApprovalStatus } from "../services/approvalQueue.js";
import { diagnoseRun, formatHaltDiagnosisHuman, type HaltDiagnosis } from "../services/haltDiagnosis.js";
import { formatEscalationRecommendationHuman, recommendModelEscalation } from "../services/modelEscalationRules.js";
import { runAgentJobThroughPipeline } from '../services/agentJobPipeline.js';


function parseApprovalStatus(
  value: string | undefined,
): ApprovalStatus | "all" {
  const normalized = String(value ?? "all")
    .trim()
    .toLowerCase();
  if (
    normalized === "all" ||
    APPROVAL_STATUSES.includes(normalized as ApprovalStatus)
  ) {
    return normalized as ApprovalStatus | "all";
  }
  throw new Error(
    `Invalid approval status "${value}". Valid values: all, ${APPROVAL_STATUSES.join(", ")}`,
  );
}

function printApprovalRequestRequired(
  status: string,
  record: ApprovalRecord,
  json: boolean,
): void {
  const payload = {
    status,
    approval: record,
    next: [
      `babel approvals approve ${record.id}`,
      "Re-run the blocked command after approval.",
    ],
  };
  printJsonOrHuman(
    payload,
    `${formatApprovalHuman(record)}\n\nNext: babel approvals approve ${record.id}`,
    json,
  );
}

function parseValidMode(
  value: string | undefined,
  fallback: ValidMode = "chat",
): ValidMode {
  const raw = String(value ?? fallback)
    .trim()
    .toLowerCase();
  const resolved = resolveMode(raw);
  if (resolved.deprecated && resolved.note) {
    process.stderr.write(`[DEPRECATED] ${resolved.note}\n`);
  }
  return resolved.mode;
}

function parseSemicolonCommands(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(";")
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

function jobRequiresApproval(job: AgentJob): boolean {
  const approvalState = getAgentJobApprovalState(job);
  return approvalState.pending.length > 0 || approvalState.denied.length > 0;
}

async function runAgentJobNow(jobId: string): Promise<AgentJob> {
  const existing = getAgentJob(jobId);
  if (!existing) {
    throw new Error(`Job not found: ${jobId}`);
  }
  if (existing.status === "paused") {
    throw new Error(`Job is paused: ${jobId}`);
  }
  if (jobRequiresApproval(existing)) {
    const diagnosis = diagnoseRun({
      approvalRequired: true,
      escalation: existing.escalation,
    });
    return updateAgentJob(existing.id, {
      status: "waiting_approval",
      diagnosis,
      error: diagnosis.headline,
    });
  }

  const running = updateAgentJob(existing.id, {
    status: "running",
    error: null,
  });

  const pipelineRun = await runAgentJobThroughPipeline(running);
  const updated = updateAgentJob(running.id, {
    status: pipelineRun.status,
    run_dir: pipelineRun.result.runDir ?? null,
    pipeline_status: pipelineRun.result.status,
    completion_verification: pipelineRun.completionVerification,
    diagnosis: pipelineRun.diagnosis,
    error: pipelineRun.error,
  });
  return writeAgentJobReport(updated);
}

export function registerCoreAutomationCommands(program: Command): void {
const approvalsCommand = program
    .command("approvals")
    .description(
      "Manage approval requests for installs, unattended jobs, and expensive model escalation",
    )
    .addHelpText(
      "after",
      `
Examples:
  $ babel-harness approvals list --json
  $ babel-harness approvals approve dep-abc123 --json
  $ babel-harness approvals deny model-abc123
  $ babel-harness approvals request-install --command "npm install" --project-root /tmp/scratch\\hello-cli --json

Notes:
  - OpenClaw manager creates pending install approvals automatically when blocked.
  - Interactive model flags approve that one run; queued model approvals are for unattended or repeated escalation.
  - Approved requests expire by default after 24 hours.
`,
    )
    .action(() => {
      const records = listApprovals({ status: "pending" });
      process.stdout.write(`${formatApprovalListHuman(records)}\n`);
    });

approvalsCommand
    .command("list")
    .description("List approval requests")
    .option(
      "--status <status>",
      `Filter: all | ${APPROVAL_STATUSES.join(" | ")}`,
      "all",
    )
    .option("--json", "Emit structured JSON only")
    .action((options: { status?: string; json?: boolean }) => {
      try {
        const status = parseApprovalStatus(options.status);
        const records = listApprovals({ status });
        printJsonOrHuman(
          { status: "ok", count: records.length, approvals: records },
          formatApprovalListHuman(records),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

approvalsCommand
    .command("inspect")
    .description("Inspect one approval request")
    .argument("<id>", "Approval id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      const record = inspectApproval(id);
      if (!record) {
        printJsonErrorAndExit(
          `Approval request not found: ${id}`,
          options.json === true,
        );
      }
      printJsonOrHuman(
        { status: "ok", approval: record },
        formatApprovalHuman(record),
        options.json === true,
      );
    });

approvalsCommand
    .command("approve")
    .description("Approve a pending request")
    .argument("<id>", "Approval id")
    .option("--ttl-hours <hours>", "Hours before the approval expires", "24")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { ttlHours?: string; json?: boolean }) => {
      try {
        const ttlHours = Number.parseInt(options.ttlHours ?? "24", 10);
        if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
          throw new Error("--ttl-hours must be a positive integer.");
        }
        const record = approveApproval(id, { ttlHours });
        printJsonOrHuman(
          { status: "ok", approval: record },
          formatApprovalHuman(record),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

approvalsCommand
    .command("deny")
    .description("Deny a pending request")
    .argument("<id>", "Approval id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const record = denyApproval(id);
        printJsonOrHuman(
          { status: "ok", approval: record },
          formatApprovalHuman(record),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

approvalsCommand
    .command("request-install")
    .description("Create or reuse a dependency-install approval request")
    .requiredOption(
      "--command <command>",
      'Exact install command to approve, such as "npm install"',
    )
    .option("--project-root <path>", "Project root scope")
    .option(
      "--execution-profile <profile>",
      "Execution profile scope",
      "workspace_manager",
    )
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        command?: string;
        projectRoot?: string;
        executionProfile?: string;
        json?: boolean;
      }) => {
        try {
          const request = requestDependencyInstallApproval({
            command: options.command ?? "",
            projectRoot: options.projectRoot ?? null,
            executionProfile: options.executionProfile ?? "workspace_manager",
          });
          printApprovalRequestRequired(
            request.created ? "approval_requested" : "approval_existing",
            request.record,
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

approvalsCommand
    .command("request-escalation")
    .description("Create or reuse a model-escalation approval request")
    .requiredOption(
      "--task <task>",
      "Exact task text that will be re-run after approval",
    )
    .option("--model <model>", "Requested model family or backend")
    .option("--model-tier <tier>", "Requested model tier", "escalation")
    .option("--project-root <path>", "Project root scope")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        task?: string;
        model?: string;
        modelTier?: string;
        projectRoot?: string;
        json?: boolean;
      }) => {
        try {
          const request = requestModelEscalationApproval({
            task: options.task ?? "",
            model: options.model ?? null,
            modelTier: options.modelTier ?? "escalation",
            projectRoot: options.projectRoot ?? null,
          });
          printApprovalRequestRequired(
            request.created ? "approval_requested" : "approval_existing",
            request.record,
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

const jobsCommand = program
    .command("jobs")
    .description("Manage unattended OpenClaw/Babel workspace jobs")
    .addHelpText(
      "after",
      `
Examples:
  $ babel-harness jobs create "Fix tests" --project-root /tmp/scratch\\hello-cli --json
  $ babel-harness jobs list --json
  $ babel-harness jobs status job-20260428T010000Z --json
  $ babel-harness jobs approve job-20260428T010000Z --json
  $ babel-harness jobs run job-20260428T010000Z --json
  $ babel-harness jobs report job-20260428T010000Z

Notes:
  - Jobs default to execution profile workspace_manager.
  - Hard-task escalation rules create exact approval requests before expensive model use.
  - Completed OpenClaw manager jobs must pass local verification before they are marked complete.
`,
    )
    .action(() => {
      const payload = listAgentJobs();
      process.stdout.write(`${formatAgentJobListHuman(payload)}\n`);
    });

jobsCommand
    .command("create")
    .description("Create a resumable OpenClaw/Babel job")
    .argument("<task...>", "Task prompt")
    .option("--id <id>", "Stable job id")
    .option("--project-root <path>", "Approved project root")
    .option(
      "--execution-profile <profile>",
      "Execution profile",
      "workspace_manager",
    )
    .option(
      "--mode <mode>",
      `Pipeline mode: ${VALID_MODES.join(" | ")}`,
      "chat",
    )
    .option("--model <model>", "Optional model family override")
    .option("--model-tier <tier>", "Optional model tier override")
    .option("--verify <commands>", "Semicolon-separated verification commands")
    .option(
      "--no-auto-escalate",
      "Do not create escalation approvals from hard-task rules",
    )
    .option("--json", "Emit structured JSON only")
    .action(
      (
        taskParts: string[],
        options: {
          id?: string;
          projectRoot?: string;
          executionProfile?: string;
          mode?: string;
          model?: string;
          modelTier?: string;
          verify?: string;
          autoEscalate?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const job = createAgentJob({
            ...(options.id ? { id: options.id } : {}),
            task: taskParts.join(" "),
            mode: parseValidMode(options.mode),
            executionProfile: options.executionProfile ?? "workspace_manager",
            ...(options.projectRoot
              ? { projectRoot: options.projectRoot }
              : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.modelTier ? { modelTier: options.modelTier } : {}),
            verifyCommands: parseSemicolonCommands(options.verify),
            autoEscalate: options.autoEscalate !== false,
          });
          printJsonOrHuman(
            { status: "ok", job },
            formatAgentJobHuman(job),
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

jobsCommand
    .command("list")
    .description("List jobs")
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const payload = listAgentJobs();
      printJsonOrHuman(
        { status: "ok", ...payload },
        formatAgentJobListHuman(payload),
        options.json === true,
      );
    });

jobsCommand
    .command("status")
    .description("Inspect one job")
    .argument("<id>", "Job id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      const job = getAgentJob(id);
      if (!job) {
        printJsonErrorAndExit(`Job not found: ${id}`, options.json === true);
      }
      printJsonOrHuman(
        { status: "ok", job },
        formatAgentJobHuman(job),
        options.json === true,
      );
    });

jobsCommand
    .command("approve")
    .description("Approve all pending approvals for a job")
    .argument("<id>", "Job id")
    .option("--ttl-hours <hours>", "Hours before approvals expire", "24")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { ttlHours?: string; json?: boolean }) => {
      try {
        const ttlHours = Number.parseInt(options.ttlHours ?? "24", 10);
        if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
          throw new Error("--ttl-hours must be a positive integer.");
        }
        const result = approveAgentJob(id, { ttlHours });
        printJsonOrHuman(
          { status: "ok", job: result.job, approvals: result.approvals },
          `${formatAgentJobHuman(result.job)}\n\nApproved: ${result.approvals.map((record) => record.id).join(", ") || "(none)"}`,
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

jobsCommand
    .command("pause")
    .description("Pause a queued job")
    .argument("<id>", "Job id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const job = pauseAgentJob(id);
        printJsonOrHuman(
          { status: "ok", job },
          formatAgentJobHuman(job),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

jobsCommand
    .command("resume")
    .description("Return a paused or approval-satisfied job to queued state")
    .argument("<id>", "Job id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const job = resumeAgentJob(id);
        printJsonOrHuman(
          { status: "ok", job },
          formatAgentJobHuman(job),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

jobsCommand
    .command("run")
    .description("Run or resume one job now")
    .argument("<id>", "Job id")
    .option("--json", "Emit structured JSON only")
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const job = await runAgentJobNow(id);
        printJsonOrHuman(
          { status: job.status, job },
          formatAgentJobHuman(job),
          options.json === true,
        );
        if (job.status !== "complete") {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

jobsCommand
    .command("report")
    .description("Write and print a job report")
    .argument("<id>", "Job id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const job = getAgentJob(id);
        if (!job) {
          throw new Error(`Job not found: ${id}`);
        }
        const reported = writeAgentJobReport(job);
        printJsonOrHuman(
          { status: "ok", job: reported },
          formatAgentJobHuman(reported),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

const escalationCommand = program
    .command("escalation")
    .description("Inspect model escalation routing recommendations")
    .action(() => {
      escalationCommand.help({ error: false });
    });

escalationCommand
    .command("recommend")
    .description("Explain whether a task should use the escalation tier")
    .argument("<task...>", "Task text")
    .option("--json", "Emit structured JSON only")
    .action((taskParts: string[], options: { json?: boolean }) => {
      const task = taskParts.join(" ");
      const recommendation = recommendModelEscalation({ task });
      printJsonOrHuman(
        { status: "ok", recommendation },
        formatEscalationRecommendationHuman(recommendation),
        options.json === true,
      );
    });

const diagnoseCommand = program
    .command("diagnose")
    .description("Diagnose Babel run/job halts and next actions")
    .action(() => {
      diagnoseCommand.help({ error: false });
    });

diagnoseCommand
    .command("run")
    .description("Diagnose a run directory")
    .argument("<run>", "Run directory")
    .option("--json", "Emit structured JSON only")
    .action((runDir: string, options: { json?: boolean }) => {
      const diagnosis = diagnoseRun({ runDir });
      printJsonOrHuman(
        { status: "ok", diagnosis },
        formatHaltDiagnosisHuman(diagnosis),
        options.json === true,
      );
    });

diagnoseCommand
    .command("job")
    .description("Diagnose a job")
    .argument("<id>", "Job id")
    .option("--json", "Emit structured JSON only")
    .action((id: string, options: { json?: boolean }) => {
      const job = getAgentJob(id);
      if (!job) {
        printJsonErrorAndExit(`Job not found: ${id}`, options.json === true);
      }
      const diagnosis =
        job.diagnosis ??
        diagnoseRun({
          runDir: job.run_dir,
          pipelineStatus: job.pipeline_status,
          approvalRequired: job.status === "waiting_approval",
          verification: job.completion_verification,
          escalation: job.escalation,
        });
      printJsonOrHuman(
        { status: "ok", diagnosis },
        formatHaltDiagnosisHuman(diagnosis),
        options.json === true,
      );
    });

diagnoseCommand
    .command("bdns")
    .description("Diagnose bounded BDNS evidence for a run")
    .argument("[run]", "Run directory or latest", "latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--json", "Emit structured JSON only")
    .action(
      async (runArg: string, options: { project?: string; json?: boolean }) => {
        const runDir = resolveInspectRunDir({
          run: runArg,
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
    );
}
