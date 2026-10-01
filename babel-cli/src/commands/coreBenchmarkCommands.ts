import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { formatEvalDoctorHuman, runEvalDoctor } from "../eval/evalDoctor.js";
import { runCodingCanary, describeCanaryPlan } from "../eval/canary/runner.js";
import { GLM_CERTIFICATION_STAGES, evaluateGlmCertification, loadGlmCertificationStages, loadGlmSessionLog, writeGlmCertificationReport, type GlmCertificationStage } from "../eval/glmCertification.js";
import { projectEvaluationEpisode } from "../eval/projectEpisode.js";
import { type SessionEventLog } from "../agent/sessionEvents.js";
import { formatProductBenchmarkHuman, runProductBenchmark } from "../services/productBenchmark.js";
import { formatProductionBenchmarkHuman, runProductionBenchmark } from "../services/productionBenchmark.js";
import { formatParityBenchmarkHuman, runParityBenchmark } from "../services/parityBenchmark.js";
import { formatCalibrationBenchmarkHuman, runCalibrationBenchmark, runCalibrationBenchmarkLive } from "../services/calibrationBenchmark.js";
import { formatInjectionBenchmarkHuman, runInjectionBenchmark, runInjectionBenchmarkLive } from "../services/injectionBenchmark.js";
import { buildLiteUsabilityReport, formatLiteUsabilityReportHuman } from "../services/liteUsability.js";
import { formatCliSmokeBenchmarkHuman, runCliSmokeBenchmark } from "../services/cliSmokeBenchmark.js";
import { buildRealTaskPilotReport, formatRealTaskPilotHuman } from "../services/realTaskPilot.js";
import { buildBenchmarkImprovementLoopReport, formatBenchmarkImprovementLoopHuman } from "../services/benchmarkImprovementLoop.js";
import { analyzeTerminalBenchRun, formatBenchmarkRunAnalysisHuman } from "../services/benchmarkAnalysis.js";
import { buildBenchmarkRepairReport, formatBenchmarkRepairHuman } from "../services/benchmarkRepair.js";
import { formatBenchmarkRepairLoopHuman, runBenchmarkRepairLoop } from "../services/benchmarkRepairLoop.js";
import { ActionableCommandError, buildMissingBenchmarkResultRootError, collectBenchmarkResultPaths, exitWithRuntimeValidationFailure, parsePositiveIntOption, readBenchmarkResultMetadata, resolveBenchmarkAnalyzeRun, resolveBenchmarkProvider, validateRuntimeEnvForCommand } from './coreCommandSupport.js';

function printActionableErrorAndExit(
  error: ActionableCommandError,
  json: boolean,
): never {
  printJsonOrHuman(error.payload, error.human, json);
  process.exit(1);
}

function printCommandErrorAndExit(error: unknown, json: boolean): never {
  if (error instanceof ActionableCommandError) {
    printActionableErrorAndExit(error, json);
  }
  printJsonErrorAndExit(
    error instanceof Error ? error.message : String(error),
    json,
  );
}

function parseReadinessProfileOption(
  value: string | undefined,
): "fast" | "full" | "release" {
  const normalized = String(value ?? "full")
    .trim()
    .toLowerCase();
  if (
    normalized === "fast" ||
    normalized === "full" ||
    normalized === "release"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid readiness profile "${value}". Valid values: fast, full, release`,
  );
}

export function registerCoreBenchmarkCommands(program: Command): void {
const benchmarkCommand = program
    .command("benchmark")
    .alias("bench")
    .description("Run local Babel benchmark suites")
    .action(() => {
      benchmarkCommand.help({ error: false });
    });

benchmarkCommand
    .command("doctor")
    .description(
      "Report evaluation catalog and dataset readiness without crashing on missing fixtures",
    )
    .option("--json", "Emit structured JSON only")
    .action((options: { json?: boolean }) => {
      const report = runEvalDoctor();
      printJsonOrHuman(
        report,
        formatEvalDoctorHuman(report),
        options.json === true,
      );
      if (!report.ok) process.exit(1);
    });

benchmarkCommand
    .command("canary")
    .description("Run the coding-loop canary (mock/structural by default)")
    .option("--plan", "List canary contract without executing")
    .option("--task <id>", "Single canary task id (C01–C13)")
    .option(
      "--tasks <ids>",
      "Comma-separated canary task ids for one aggregate run",
    )
    .option("--provider <p>", "mock | live", "mock")
    .option("--i-authorize-live", "Required to spend live model tokens")
    .option(
      "--smoke",
      "LIVE_SMOKE: C01 only, exactly one trial; not aggregated as live capability",
    )
    .option(
      "--trials <n>",
      "Repeated trials (default 3 live baseline; fixed 1 under --smoke)",
    )
    .option("--model <id>", "Chat model id (default deepseek-v4-flash-openrouter via OpenRouter)")
    .option(
      "--evidence-dir <path>",
      "Persist per-cell evidence and the aggregate canary report",
    )
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        plan?: boolean;
        task?: string;
        tasks?: string;
        provider?: string;
        json?: boolean;
        iAuthorizeLive?: boolean;
        smoke?: boolean;
        trials?: string;
        model?: string;
        evidenceDir?: string;
      }) => {
        if (options.plan) {
          // Plan must describe the exact execution the same flags would run.
          const parsedPlanTrials = options.trials
            ? Number.parseInt(options.trials, 10)
            : NaN;
          const plan = describeCanaryPlan({
            provider: options.provider === "live" ? "live" : "mock",
            smoke: options.smoke === true,
            ...(options.task ? { taskId: options.task } : {}),
            ...(options.tasks
              ? {
                  taskIds: options.tasks
                    .split(",")
                    .map((id) => id.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(Number.isFinite(parsedPlanTrials)
              ? { trials: parsedPlanTrials }
              : {}),
            ...(options.model ? { model: options.model } : {}),
          });
          printJsonOrHuman(
            plan,
            `coding-canary plan: ${plan.tasks} task(s) [${plan.task_ids.join(", ")}], ${plan.trials_per_task} trial(s) each`,
            options.json === true,
          );
          return;
        }
        const provider = options.provider === "live" ? "live" : "mock";
        const parsedTrials = options.trials
          ? Number.parseInt(options.trials, 10)
          : NaN;
        const report = runCodingCanary({
          provider,
          authorizeLive: options.iAuthorizeLive === true,
          smoke: options.smoke === true,
          ...(options.task ? { taskId: options.task } : {}),
          ...(options.tasks
            ? {
                taskIds: options.tasks
                  .split(",")
                  .map((id) => id.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(Number.isFinite(parsedTrials) ? { trials: parsedTrials } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.evidenceDir
            ? { evidenceDir: resolve(options.evidenceDir) }
            : {}),
        });
        if (options.evidenceDir) {
          const evidenceDir = resolve(options.evidenceDir);
          mkdirSync(evidenceDir, { recursive: true });
          writeFileSync(
            join(evidenceDir, "canary-report.json"),
            `${JSON.stringify(report, null, 2)}\n`,
            "utf8",
          );
        }
        printJsonOrHuman(
          report,
          `canary scope=${report.evidence_scope} contract=${report.contract_success_rate}`,
          options.json === true,
        );
      },
    );

benchmarkCommand
    .command("glm-cert")
    .description(
      "Evaluate persisted exact-GLM evidence against the C0–C6 certification ladder",
    )
    .option(
      "--plan",
      "Print the certification stages and gates without reading evidence",
    )
    .option("--run-dir <path>", "Run directory containing session-events.jsonl")
    .option(
      "--stages-dir <path>",
      "Root containing C0..C6 subdirectories with persisted session logs",
    )
    .option(
      "--stage <stage>",
      "Stage represented by --run-dir (default C0)",
      "C0",
    )
    .option(
      "--evidence-dir <path>",
      "Directory for the persisted certification report",
    )
    .option("--write-report", "Write glm-certification-report.json and .md")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        plan?: boolean;
        runDir?: string;
        stagesDir?: string;
        stage?: string;
        evidenceDir?: string;
        writeReport?: boolean;
        json?: boolean;
      }) => {
        if (options.plan) {
          const plan = {
            kind: "babel_glm_certification_plan",
            model: "z-ai/glm-5.3-flash",
            provider: "openrouter",
            stages: GLM_CERTIFICATION_STAGES,
            entry_gate: "exact provider/model route is configured",
            advancement_rule:
              "each stage must have persisted evidence and pass before advancing",
            c0_c4_rule: "C0–C4 must all be green before broad live testing",
          };
          printJsonOrHuman(
            plan,
            `GLM certification stages: ${GLM_CERTIFICATION_STAGES.join(", ")}`,
            options.json === true,
          );
          return;
        }
        if (!options.runDir) {
          if (!options.stagesDir) {
            throw new Error(
              "benchmark glm-cert requires --run-dir or --stages-dir, or use --plan",
            );
          }
        }
        if (options.runDir && options.stagesDir) {
          throw new Error(
            "benchmark glm-cert accepts either --run-dir or --stages-dir, not both",
          );
        }
        let stages: Partial<
          Record<GlmCertificationStage, readonly SessionEventLog[]>
        >;
        let evidenceRefs: Partial<
          Record<GlmCertificationStage, readonly string[]>
        >;
        let referenceRoots: Partial<
          Record<GlmCertificationStage, readonly string[]>
        >;
        let reportRoot: string;
        let loadedStages: GlmCertificationStage[];
        let missingStages: GlmCertificationStage[];
        if (options.stagesDir) {
          const bundle = loadGlmCertificationStages(resolve(options.stagesDir));
          stages = bundle.stages;
          evidenceRefs = bundle.evidence_refs;
          referenceRoots = bundle.reference_roots;
          reportRoot = bundle.root;
          loadedStages = bundle.loaded_stages;
          missingStages = bundle.missing_stages;
        } else {
          const stage = (
            options.stage ?? "C0"
          ).toUpperCase() as GlmCertificationStage;
          if (
            !(GLM_CERTIFICATION_STAGES as readonly string[]).includes(stage)
          ) {
            throw new Error(
              `benchmark glm-cert received invalid stage "${options.stage}"`,
            );
          }
          const runDir = resolve(options.runDir!);
          const log = loadGlmSessionLog(runDir);
          if (!log) {
            throw new Error(
              `benchmark glm-cert found no session-events.jsonl under ${runDir}`,
            );
          }
          stages = { [stage]: [log] };
          evidenceRefs = { [stage]: [runDir] };
          referenceRoots = { [stage]: [runDir] };
          reportRoot = runDir;
          loadedStages = [stage];
          missingStages = GLM_CERTIFICATION_STAGES.filter(
            (candidate) => candidate !== stage,
          );
        }
        const evaluatedReport = evaluateGlmCertification({
          stages,
          evidence_refs: evidenceRefs,
          reference_roots: referenceRoots,
        });
        const report = {
          ...evaluatedReport,
          certification_inputs: {
            loaded_stages: loadedStages,
            missing_stages: missingStages,
          },
        };
        let reportPaths: { jsonPath: string; markdownPath: string } | undefined;
        if (options.writeReport) {
          reportPaths = writeGlmCertificationReport(
            resolve(options.evidenceDir ?? dirname(reportRoot)),
            report,
          );
        }
        printJsonOrHuman(
          reportPaths ? { ...report, report_paths: reportPaths } : report,
          `GLM certification status=${report.overall_status} C0-C4=${report.c0_c4_green}`,
          options.json === true,
        );
        if (report.overall_status !== "pass") process.exitCode = 1;
      },
    );

benchmarkCommand
    .command("episode")
    .description(
      "Project an EvaluationEpisode from a run directory (forensic; degrades if jsonl missing)",
    )
    .argument("<runDir>", "Run directory containing session/episode jsonl")
    .option("--json", "Emit structured JSON only")
    .option("--task <id>", "Task id label")
    .action((runDir: string, options: { json?: boolean; task?: string }) => {
      const episode = projectEvaluationEpisode({
        runDir,
        ...(options.task ? { task_id: options.task } : {}),
      });
      printJsonOrHuman(
        episode,
        `episode task=${episode.identity.task_id} claim_eligible=${episode.claim_eligible} confidence=${episode.diagnosis_confidence}`,
        options.json === true,
      );
    });

benchmarkCommand
    .command("smoke")
    .description("Run a small Babel vs Babel Lite smoke benchmark")
    .option("--live", "Call the configured provider and run the CLI cases")
    .option("--modes <modes>", "Comma-separated modes: babel,bl", "babel,bl")
    .option("--model <model>", "Model family for live provider-backed cases")
    .option("--model-tier <tier>", "Model tier for live provider-backed cases")
    .option("--timeout-ms <n>", "Per-case timeout in milliseconds", "420000")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        live?: boolean;
        modes?: string;
        model?: string;
        modelTier?: string;
        timeoutMs?: string;
        outputDir?: string;
        json?: boolean;
      }) => {
        const timeoutMs = Number.parseInt(options.timeoutMs ?? "420000", 10);
        const report = runCliSmokeBenchmark({
          live: options.live === true,
          modes: (options.modes ?? "babel,bl").split(","),
          ...(options.model ? { model: options.model } : {}),
          ...(options.modelTier ? { modelTier: options.modelTier } : {}),
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 420_000,
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        });
        printJsonOrHuman(
          report,
          formatCliSmokeBenchmarkHuman(report),
          options.json === true,
        );
        if (report.summary.failed > 0) {
          process.exit(1);
        }
      },
    );

benchmarkCommand
    .command("lite")
    .description(
      "Compare Babel Lite daily commands against full Babel command shapes",
    )
    .option("--json", "Emit structured JSON only")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .option("--fixture <path>", "Override Lite usability fixture path")
    .action(
      (options: { json?: boolean; outputDir?: string; fixture?: string }) => {
        const report = buildLiteUsabilityReport({
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
          ...(options.fixture ? { fixturePath: options.fixture } : {}),
        });
        printJsonOrHuman(
          report,
          formatLiteUsabilityReportHuman(report),
          options.json === true,
        );
        if (report.summary.fail > 0) {
          process.exit(1);
        }
      },
    );

benchmarkCommand
    .command("real-tasks")
    .description("Prepare a non-mutating pilot checklist for real repo tasks")
    .option("--project-root <path>", "Project root to pilot against", ".")
    .option("--output-dir <path>", "Pilot artifact output directory")
    .option("--json", "Emit structured JSON only")
    .action(
      (options: {
        projectRoot?: string;
        outputDir?: string;
        json?: boolean;
      }) => {
        const report = buildRealTaskPilotReport({
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        });
        printJsonOrHuman(
          report,
          formatRealTaskPilotHuman(report),
          options.json === true,
        );
      },
    );

benchmarkCommand
    .command("product")
    .description("Run the Babel CLI product-gap benchmark")
    .option("--json", "Emit structured JSON only")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .action((options: { json?: boolean; outputDir?: string }) => {
      const report = runProductBenchmark({
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      });
      printJsonOrHuman(
        report,
        formatProductBenchmarkHuman(report),
        options.json === true,
      );
      if (report.summary.fail > 0 || report.summary.not_implemented > 0) {
        process.exit(1);
      }
    });

benchmarkCommand
    .command("parity")
    .description("Create the Phase 12 comparative parity benchmark artifact")
    .option("--json", "Emit structured JSON only")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .option("--fixture <path>", "Measured parity results fixture JSON")
    .action(
      (options: { json?: boolean; outputDir?: string; fixture?: string }) => {
        const report = runParityBenchmark({
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
          ...(options.fixture ? { fixturePath: options.fixture } : {}),
        });
        printJsonOrHuman(
          report,
          formatParityBenchmarkHuman(report),
          options.json === true,
        );
      },
    );

benchmarkCommand
    .command("production")
    .description(
      "Create the scoped production-readiness proof benchmark artifact",
    )
    .option("--json", "Emit structured JSON only")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .option("--proof-root <path>", "Production proof artifact root")
    .action(
      (options: { json?: boolean; outputDir?: string; proofRoot?: string }) => {
        const report = runProductionBenchmark({
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
          ...(options.proofRoot ? { proofRoot: options.proofRoot } : {}),
        });
        printJsonOrHuman(
          report,
          formatProductionBenchmarkHuman(report),
          options.json === true,
        );
      },
    );

benchmarkCommand
    .command("calibration")
    .description("Run the Evidence Label calibration benchmark (OLS-MCC P2(b))")
    .option("--json", "Emit structured JSON only")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .option("--tasks <n>", "Number of test tasks to run (default: all)", "23")
    .option(
      "--live",
      "Run with live DeepSeek LLM calls through OpenRouter (uses OPENROUTER_API_KEY)",
    )
    .option("--model <model>", "Model ID for live mode (provider shorthand)")
    .option("--delay-ms <n>", "Delay between LLM calls in ms", "500")
    .option(
      "--provider <name>",
      "LLM provider: DeepSeek control through OpenRouter or OpenRouter GLM",
      "deepseek",
    )
    .option(
      "--label-mode <mode>",
      "Label comparison mode: numerical-vs-none (default) or numerical-vs-categorical (P1 variant)",
      "numerical-vs-none",
    )
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        tasks?: string;
        live?: boolean;
        model?: string;
        delayMs?: string;
        provider?: string;
        labelMode?: string;
      }) => {
        try {
          const labelMode =
            options.labelMode === "numerical-vs-none" ||
            options.labelMode === "numerical-vs-categorical"
              ? options.labelMode
              : undefined;
          if (options.live) {
            const { provider, apiKey, defaultModel } = resolveBenchmarkProvider(
              options.provider ?? "deepseek",
              options.model,
            );

            const model = options.model ?? defaultModel;
            const delayMs = Number.parseInt(options.delayMs ?? "500", 10);
            const taskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = await runCalibrationBenchmarkLive({
              modelId: model,
              ...(taskCount !== undefined ? { taskCount } : {}),
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              ...(labelMode ? { labelMode } : {}),
              delayMs: Number.isFinite(delayMs) ? delayMs : 500,
              llmCall: async (prompt: string): Promise<string> => {
                if (provider === "anthropic") {
                  const resp = await fetch(
                    "https://api.anthropic.com/v1/messages",
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                      },
                      body: JSON.stringify({
                        model,
                        max_tokens: 1024,
                        temperature: 0,
                        messages: [{ role: "user", content: prompt }],
                      }),
                    },
                  );
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "unknown");
                    throw new Error(
                      `${provider} API error ${resp.status}: ${errBody}`,
                    );
                  }
                  const data = (await resp.json()) as {
                    content: Array<{ type: string; text: string }>;
                  };
                  return data.content?.[0]?.text ?? "";
                } else if (provider === "gemini") {
                  const resp = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": apiKey,
                      },
                      body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                          temperature: 0,
                          maxOutputTokens: 1024,
                        },
                      }),
                    },
                  );
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "unknown");
                    throw new Error(
                      `${provider} API error ${resp.status}: ${errBody}`,
                    );
                  }
                  const data = (await resp.json()) as {
                    candidates?: Array<{
                      content?: { parts?: Array<{ text: string }> };
                    }>;
                  };
                  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                } else {
                  if (provider !== "openrouter") {
                    throw new Error(
                      `[LIVE_MODEL_POLICY] Calibration live calls must use OpenRouter; received ${provider}.`,
                    );
                  }
                  const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
                  const resp = await fetch(apiUrl, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model,
                      messages: [{ role: "user", content: prompt }],
                      max_tokens: 1024,
                      temperature: 0,
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "unknown");
                    throw new Error(
                      `${provider} API error ${resp.status}: ${errBody}`,
                    );
                  }
                  const data = (await resp.json()) as {
                    choices: Array<{ message: { content: string } }>;
                  };
                  return data.choices[0]?.message?.content ?? "";
                }
              },
            });
            printJsonOrHuman(
              report,
              formatCalibrationBenchmarkHuman(report),
              options.json === true,
            );
            if (report.summary.verdict === "REFUTED") {
              process.exit(1);
            }
          } else {
            // Offline mode: produce skeleton
            const offlineTaskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = runCalibrationBenchmark({
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              ...(offlineTaskCount !== undefined
                ? { taskCount: offlineTaskCount }
                : {}),
              ...(labelMode ? { labelMode } : {}),
            });
            printJsonOrHuman(
              report,
              formatCalibrationBenchmarkHuman(report),
              options.json === true,
            );
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

benchmarkCommand
    .command("injection")
    .description(
      "Run the Authority Order injection resistance benchmark (OLS-MCC P0)",
    )
    .option("--json", "Emit structured JSON only")
    .option("--output-dir <path>", "Benchmark artifact output directory")
    .option("--tasks <n>", "Number of test tasks to run (default: all)", "36")
    .option(
      "--live",
      "Run with live DeepSeek LLM calls through OpenRouter (uses OPENROUTER_API_KEY)",
    )
    .option("--model <model>", "Model ID for live mode (provider shorthand)")
    .option("--delay-ms <n>", "Delay between LLM calls in ms", "500")
    .option(
      "--provider <name>",
      "LLM provider: DeepSeek control through OpenRouter or OpenRouter GLM",
      "deepseek",
    )
    .option(
      "--variant <v1|v2>",
      "Authority Order variant to test (default: v2 hardened)",
      "v2",
    )
    .option(
      "--multi-turn-defense",
      "Enable Conversation Boundary Marker defense against multi-turn erosion attacks",
    )
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        tasks?: string;
        live?: boolean;
        model?: string;
        delayMs?: string;
        provider?: string;
        variant?: string;
        multiTurnDefense?: boolean;
      }) => {
        try {
          if (options.live) {
            const { provider, apiKey, defaultModel } = resolveBenchmarkProvider(
              options.provider ?? "deepseek",
              options.model,
            );

            const model = options.model ?? defaultModel;
            const delayMs = Number.parseInt(options.delayMs ?? "500", 10);
            const taskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = await runInjectionBenchmarkLive({
              modelId: model,
              ...(taskCount !== undefined ? { taskCount } : {}),
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              aoVariant: (options.variant === "v1" ? "v1" : "v2") as
                | "v1"
                | "v2",
              multiTurnDefense: options.multiTurnDefense === true,
              delayMs: Number.isFinite(delayMs) ? delayMs : 500,
              llmCall: async (prompt: string): Promise<string> => {
                if (provider === "anthropic") {
                  const resp = await fetch(
                    "https://api.anthropic.com/v1/messages",
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                      },
                      body: JSON.stringify({
                        model,
                        max_tokens: 1024,
                        temperature: 0,
                        messages: [{ role: "user", content: prompt }],
                      }),
                    },
                  );
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "unknown");
                    throw new Error(
                      `${provider} API error ${resp.status}: ${errBody}`,
                    );
                  }
                  const data = (await resp.json()) as {
                    content: Array<{ type: string; text: string }>;
                  };
                  return data.content?.[0]?.text ?? "";
                } else if (provider === "gemini") {
                  const resp = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": apiKey,
                      },
                      body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                          temperature: 0,
                          maxOutputTokens: 1024,
                        },
                      }),
                    },
                  );
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "unknown");
                    throw new Error(
                      `${provider} API error ${resp.status}: ${errBody}`,
                    );
                  }
                  const data = (await resp.json()) as {
                    candidates?: Array<{
                      content?: { parts?: Array<{ text: string }> };
                    }>;
                  };
                  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                } else {
                  if (provider !== "openrouter") {
                    throw new Error(
                      `[LIVE_MODEL_POLICY] Injection live calls must use OpenRouter; received ${provider}.`,
                    );
                  }
                  const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
                  const resp = await fetch(apiUrl, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model,
                      messages: [{ role: "user", content: prompt }],
                      max_tokens: 1024,
                      temperature: 0,
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => "unknown");
                    throw new Error(
                      `${provider} API error ${resp.status}: ${errBody}`,
                    );
                  }
                  const data = (await resp.json()) as {
                    choices: Array<{ message: { content: string } }>;
                  };
                  return data.choices[0]?.message?.content ?? "";
                }
              },
            });
            printJsonOrHuman(
              report,
              formatInjectionBenchmarkHuman(report),
              options.json === true,
            );
            if (report.summary.verdict === "REFUTED") {
              process.exit(1);
            }
          } else {
            // Offline mode: produce skeleton
            const offlineTaskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = runInjectionBenchmark({
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              ...(offlineTaskCount !== undefined
                ? { taskCount: offlineTaskCount }
                : {}),
              aoVariant: (options.variant === "v1" ? "v1" : "v2") as
                | "v1"
                | "v2",
              multiTurnDefense: options.multiTurnDefense === true,
            });
            printJsonOrHuman(
              report,
              formatInjectionBenchmarkHuman(report),
              options.json === true,
            );
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

benchmarkCommand
    .command("analyze")
    .description(
      "Analyze a Terminal-Bench run and emit a Codex repair work packet",
    )
    .argument("[run]", "Run directory, result.json path, or latest", "latest")
    .option("--json", "Emit structured JSON only")
    .option("--benchmarks-root <path>", "Benchmarks workspace root")
    .option(
      "--suite <name>",
      "Terminal-Bench suite for latest lookup",
      "pilot10",
    )
    .action(
      (
        runArg: string | undefined,
        options: { json?: boolean; benchmarksRoot?: string; suite?: string },
      ) => {
        try {
          const run = resolveBenchmarkAnalyzeRun(runArg ?? "latest", {
            ...(options.benchmarksRoot
              ? { benchmarksRoot: options.benchmarksRoot }
              : {}),
            suite: options.suite ?? "pilot10",
          });
          const analysis = analyzeTerminalBenchRun({ run });
          printJsonOrHuman(
            analysis,
            formatBenchmarkRunAnalysisHuman(analysis),
            options.json === true,
          );
        } catch (err: unknown) {
          printCommandErrorAndExit(err, options.json === true);
        }
      },
    );

benchmarkCommand
    .command("repair")
    .description(
      "Generate a focused benchmark repair plan and prompt from a failed Terminal-Bench run",
    )
    .argument("[run]", "Run directory, result.json path, or latest", "latest")
    .option("--json", "Emit structured JSON only")
    .option("--benchmarks-root <path>", "Benchmarks workspace root")
    .option(
      "--suite <name>",
      "Terminal-Bench suite for latest lookup",
      "pilot10",
    )
    .option(
      "--max-tasks <n>",
      "Full pilot task count for generated command",
      "10",
    )
    .option(
      "--output-dir <path>",
      "Repair report/prompt artifact output directory",
    )
    .action(
      (
        runArg: string | undefined,
        options: {
          json?: boolean;
          benchmarksRoot?: string;
          suite?: string;
          maxTasks?: string;
          outputDir?: string;
        },
      ) => {
        try {
          const run = resolveBenchmarkAnalyzeRun(runArg ?? "latest", {
            ...(options.benchmarksRoot
              ? { benchmarksRoot: options.benchmarksRoot }
              : {}),
            suite: options.suite ?? "pilot10",
          });
          const report = buildBenchmarkRepairReport({
            run,
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            ...(options.benchmarksRoot
              ? { benchmarksRoot: options.benchmarksRoot }
              : {}),
            suite: options.suite ?? "pilot10",
            maxTasks: parsePositiveIntOption(options.maxTasks, 10),
          });
          printJsonOrHuman(
            report,
            formatBenchmarkRepairHuman(report),
            options.json === true,
          );
        } catch (err: unknown) {
          printCommandErrorAndExit(err, options.json === true);
        }
      },
    );

benchmarkCommand
    .command("repair-run")
    .description(
      "Execute an iterative benchmark repair packet in an isolated workspace",
    )
    .argument("[run]", "Run directory, result.json path, or latest", "latest")
    .option("--json", "Emit structured JSON only")
    .option("--benchmarks-root <path>", "Benchmarks workspace root")
    .option(
      "--suite <name>",
      "Terminal-Bench suite for latest lookup",
      "pilot10",
    )
    .option(
      "--max-tasks <n>",
      "Full pilot task count for generated command",
      "10",
    )
    .option("--max-iterations <n>", "Maximum repair/check/targeted cycles", "5")
    .option(
      "--model <model>",
      "Optional model family override for Babel repair and targeted rerun",
    )
    .option(
      "--model-tier <tier>",
      "Model tier for Babel repair and targeted rerun",
      "cheap",
    )
    .option(
      "--execution-profile <profile>",
      "Execution profile for repair mode",
      "benchmark_container",
    )
    .option(
      "--deepinfra-timeout-ms <n>",
      "DeepInfra per-request timeout for repair and targeted rerun",
      "240000",
    )
    .option(
      "--waterfall-timeout-ms <n>",
      "Aggregate waterfall timeout for repair and targeted rerun",
      "720000",
    )
    .option(
      "--verifier-timeout-ms <n>",
      "Local Docker verifier timeout",
      "1200000",
    )
    .option(
      "--targeted-timeout-ms <n>",
      "Outer timeout for targeted benchmark rerun",
      "1800000",
    )
    .option("--output-dir <path>", "Repair-loop artifact output directory")
    .option(
      "--dry-run",
      "Prepare workspace and commands without running Babel, Docker verifier, or targeted benchmark",
    )
    .option(
      "--skip-babel-repair",
      "Do not run Babel repair mode; useful for verifying an existing workspace/checkpoint",
    )
    .option("--skip-local-verifier", "Do not run the local Docker verifier")
    .option(
      "--skip-targeted",
      "Do not run the targeted Terminal-Bench rerun after local pass",
    )
    .option(
      "--fail-on-unresolved",
      "Exit non-zero unless the loop reaches a local or targeted pass",
    )
    .action(
      async (
        runArg: string | undefined,
        options: {
          json?: boolean;
          benchmarksRoot?: string;
          suite?: string;
          maxTasks?: string;
          maxIterations?: string;
          model?: string;
          modelTier?: string;
          executionProfile?: string;
          deepinfraTimeoutMs?: string;
          waterfallTimeoutMs?: string;
          verifierTimeoutMs?: string;
          targetedTimeoutMs?: string;
          outputDir?: string;
          dryRun?: boolean;
          skipBabelRepair?: boolean;
          skipLocalVerifier?: boolean;
          skipTargeted?: boolean;
          failOnUnresolved?: boolean;
        },
      ) => {
        try {
          const dryRun = options.dryRun === true;
          const skipBabelRepair = options.skipBabelRepair === true;
          if (!dryRun && !skipBabelRepair) {
            validateRuntimeEnvForCommand({ json: options.json === true });
          }
          const run = resolveBenchmarkAnalyzeRun(runArg ?? "latest", {
            ...(options.benchmarksRoot
              ? { benchmarksRoot: options.benchmarksRoot }
              : {}),
            suite: options.suite ?? "pilot10",
          });
          const report = await runBenchmarkRepairLoop({
            run,
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            ...(options.benchmarksRoot
              ? { benchmarksRoot: options.benchmarksRoot }
              : {}),
            suite: options.suite ?? "pilot10",
            maxTasks: parsePositiveIntOption(options.maxTasks, 10),
            maxIterations: parsePositiveIntOption(options.maxIterations, 5),
            ...(options.model ? { model: options.model } : {}),
            ...(options.modelTier ? { modelTier: options.modelTier } : {}),
            ...(options.executionProfile
              ? { executionProfile: options.executionProfile }
              : {}),
            deepInfraTimeoutMs: parsePositiveIntOption(
              options.deepinfraTimeoutMs,
              240000,
            ),
            waterfallTimeoutMs: parsePositiveIntOption(
              options.waterfallTimeoutMs,
              720000,
            ),
            verifierTimeoutMs: parsePositiveIntOption(
              options.verifierTimeoutMs,
              1200000,
            ),
            targetedTimeoutMs: parsePositiveIntOption(
              options.targetedTimeoutMs,
              1800000,
            ),
            dryRun,
            skipBabelRepair,
            skipLocalVerifier: options.skipLocalVerifier === true,
            skipTargeted: options.skipTargeted === true,
          });
          printJsonOrHuman(
            report,
            formatBenchmarkRepairLoopHuman(report),
            options.json === true,
          );
          if (
            options.failOnUnresolved === true &&
            report.status !== "targeted_passed" &&
            report.status !== "passed_local"
          ) {
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

benchmarkCommand
    .command("loop")
    .description(
      "Run the local readiness gate and plan the Terminal-Bench improvement loop",
    )
    .option("--json", "Emit structured JSON only")
    .option("--benchmarks-root <path>", "Benchmarks workspace root")
    .option("--suite <name>", "Terminal-Bench suite", "pilot10")
    .option(
      "--readiness <profile>",
      "Readiness profile: fast, full, release",
      "full",
    )
    .option("--max-tasks <n>", "Full pilot task count", "10")
    .option("--min-passes <n>", "Promotion threshold for the full pilot", "5")
    .option("--target-task <name>", "Task to use for the next targeted canary")
    .option(
      "--model-tier <tier>",
      "Model tier for generated benchmark commands",
      "cheap",
    )
    .option(
      "--deepinfra-timeout-ms <n>",
      "DeepInfra per-request timeout for generated benchmark commands",
      "240000",
    )
    .option(
      "--waterfall-timeout-ms <n>",
      "Aggregate waterfall timeout for generated benchmark commands",
      "720000",
    )
    .option(
      "--deadline <iso>",
      "Wall-clock deadline for generated benchmark commands",
    )
    .option(
      "--min-remaining-ms <n>",
      "Minimum remaining deadline budget before starting benchmark work",
      "0",
    )
    .option(
      "--job-slug <slug>",
      "Stable job slug used in generated benchmark commands",
      "improvement-loop",
    )
    .option("--output-dir <path>", "Loop report artifact output directory")
    .option(
      "--skip-local-checks",
      "Inspect benchmark history without running local readiness commands",
    )
    .option(
      "--fail-on-unready",
      "Exit non-zero when promotion readiness is not yet achieved",
    )
    .action(
      (options: {
        json?: boolean;
        benchmarksRoot?: string;
        suite?: string;
        readiness?: string;
        maxTasks?: string;
        minPasses?: string;
        targetTask?: string;
        modelTier?: string;
        deepinfraTimeoutMs?: string;
        waterfallTimeoutMs?: string;
        deadline?: string;
        minRemainingMs?: string;
        jobSlug?: string;
        outputDir?: string;
        skipLocalChecks?: boolean;
        failOnUnready?: boolean;
      }) => {
        try {
          const report = buildBenchmarkImprovementLoopReport({
            ...(options.benchmarksRoot
              ? { benchmarksRoot: options.benchmarksRoot }
              : {}),
            ...(options.suite ? { suite: options.suite } : {}),
            readinessProfile: parseReadinessProfileOption(options.readiness),
            maxTasks: parsePositiveIntOption(options.maxTasks, 10),
            minFullPasses: parsePositiveIntOption(options.minPasses, 5),
            ...(options.targetTask ? { targetTask: options.targetTask } : {}),
            ...(options.modelTier ? { modelTier: options.modelTier } : {}),
            deepInfraTimeoutMs: parsePositiveIntOption(
              options.deepinfraTimeoutMs,
              240000,
            ),
            waterfallTimeoutMs: parsePositiveIntOption(
              options.waterfallTimeoutMs,
              720000,
            ),
            ...(options.deadline ? { deadlineAt: options.deadline } : {}),
            minRemainingMs: parsePositiveIntOption(options.minRemainingMs, 0),
            ...(options.jobSlug ? { jobSlug: options.jobSlug } : {}),
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            runLocalChecks: options.skipLocalChecks !== true,
          });
          printJsonOrHuman(
            report,
            formatBenchmarkImprovementLoopHuman(report),
            options.json === true,
          );
          if (
            report.local_readiness.status === "fail" ||
            (options.failOnUnready === true &&
              report.readiness_gate.status === "fail")
          ) {
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
}
