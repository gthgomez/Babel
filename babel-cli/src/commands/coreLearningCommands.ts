import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { registerEvidenceProductSubcommands } from "./evidenceProductCommands.js";
import { printJsonErrorAndExit, printJsonOrHuman } from "./output.js";
import { renderAvailableModelsTable, renderModelDetail, resolveModelSnapshot } from "../interactive/commands/modelDetail.js";
import { BABEL_ROOT } from "../cli/constants.js";
import { readLatestRunPointer } from "../cli/helpers.js";
import { resolveModelByKey, resolveOpenRouterDeepSeekBackendKey } from "../modelPolicy.js";
import { OpenRouterApiRunner } from "../runners/openRouterApi.js";
import { writeProofArtifacts } from "../services/proof.js";
import { formatLessonCandidateHuman, formatLessonEvalHuman, formatLearningFailureHuman, formatMutationPackageHuman, generateMutationPackage, promoteLessonToShadow, readLearningArtifact, testLessonCandidate, writeLessonCandidate, writeLearningFailureRecord } from "../services/learning.js";
import { exitWithRuntimeValidationFailure, handleProofReport, resolveProofRunArg, resolveProofRunDir, validateRuntimeEnvForCommand } from './coreCommandSupport.js';

async function handleModelsPing(options: {
  model?: string;
  json?: boolean;
  allowExpensive?: boolean;
  evidenceDir?: string;
}): Promise<void> {
  const startedAt = Date.now();
  const requestedModel = options.model?.trim() || "deepseek-v4-flash-openrouter";

  try {
    // Live DeepSeek controls are routed through OpenRouter. Keep accepting the
    // historical selector so existing commands cannot accidentally re-enable
    // the direct DEEPSEEK_API_KEY path.
    const routedModelKey =
      resolveOpenRouterDeepSeekBackendKey(requestedModel) ?? requestedModel;
    const resolved = resolveModelByKey({
      key: routedModelKey,
      allowExpensive: options.allowExpensive === true,
      liveOnly: true,
      babelRoot: BABEL_ROOT,
    });
    const runner =
      resolved.provider === "openrouter"
        ? (() => {
            if (!process.env["OPENROUTER_API_KEY"]?.trim()) {
              throw new Error(
                "[LIVE_MODEL_POLICY] OPENROUTER_API_KEY is required for OpenRouter model ping.",
              );
            }
            return new OpenRouterApiRunner(resolved.providerModelId);
          })()
        : (() => {
            if (resolved.provider === "deepseek") {
              throw new Error(
                "[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.",
              );
            }
            throw new Error(
              `[LIVE_MODEL_POLICY] Unsupported live ping provider "${resolved.provider}".`,
            );
          })();
    const schema = z.object({ ok: z.literal(true) });
    await runner.execute(
      'Return exactly this JSON object and nothing else: {"ok":true}',
      schema,
    );
    const metadata = runner.getLastInvocationMetadata();
    const payload = {
      status: "pass",
      requested_model: requestedModel,
      backend_key: resolved.resolvedBackendKey,
      provider: resolved.provider,
      provider_model_id: resolved.providerModelId,
      latency_ms: metadata?.latency_ms ?? Date.now() - startedAt,
      request_timeout_ms: Number(
        process.env["BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS"] ?? "120000",
      ),
      request_max_retries: Number(
        process.env["BABEL_DEEPSEEK_REQUEST_MAX_RETRIES"] ?? "4",
      ),
      stream_idle_timeout_ms: Number(
        process.env["BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS"] ?? "60000",
      ),
      stream_max_retries: Number(
        process.env["BABEL_DEEPSEEK_STREAM_MAX_RETRIES"] ?? "1",
      ),
    };

    if (options.evidenceDir) {
      const evidenceDir = resolve(options.evidenceDir);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "model-ping.json"),
        `${JSON.stringify(
          {
            schema_version: 1,
            kind: "babel_model_ping_evidence",
            evidence_scope: "LIVE_C0",
            ...payload,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(
        `Model ping passed: ${payload.backend_key} (${payload.provider_model_id}) in ${payload.latency_ms}ms`,
      );
    }
  } catch (err: unknown) {
    const payload = {
      status: "fail",
      requested_model: requestedModel,
      latency_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
    if (options.evidenceDir) {
      const evidenceDir = resolve(options.evidenceDir);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, "model-ping.json"),
        `${JSON.stringify(
          {
            schema_version: 1,
            kind: "babel_model_ping_evidence",
            evidence_scope: "LIVE_C0",
            ...payload,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.error(`Model check failed: ${payload.error}`);
    }
    // Let pending provider/transport handles settle before the process exits.
    // Forced exit here can produce a misleading Windows libuv shutdown
    // assertion after an otherwise correctly reported provider error.
    process.exitCode = 1;
  }
}

function printEvidenceStatus(options: {
  json?: boolean;
  project?: string;
}): void {
  const latest = readLatestRunPointer(options.project);
  const payload = {
    status: latest ? "ok" : "no_latest_run",
    latest_run: latest,
    commands: [
      "babel doctor --scope all",
      "babel inspect run latest",
      "babel inspect summary --run latest",
    ],
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log("Evidence surfaces:");
  console.log("  doctor          workspace, repo, and export health checks");
  console.log("  inspect run     complete evidence bundle view");
  console.log("  inspect summary concise run summary");
  console.log("  evidence open   implementor run diagnose (W3)");
  console.log("  evidence export portable evidence bundle (W3)");
  console.log("  evidence scorecard  Grok-shadow prove + FP dashboard (W3.3)");
  if (latest) {
    console.log(`\nLatest run: ${latest.run_dir}`);
    console.log(`Project: ${latest.project}`);
  } else {
    console.log("\nNo latest run pointer found yet.");
  }
}

function handleLearnFromRun(
  runArg: string | undefined,
  options: {
    run?: string;
    project?: string;
    last?: boolean;
    json?: boolean;
    learningRoot?: string;
  },
): void {
  try {
    const resolvedRunDir = resolveProofRunDir(runArg, options);
    const proofArtifacts = writeProofArtifacts(resolvedRunDir);
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, "learning");
    const learningArtifacts = writeLearningFailureRecord({
      runDir: resolvedRunDir,
      learningRoot,
      proof: proofArtifacts.proof,
    });
    const payload = {
      status: "ok",
      learning_root: learningRoot,
      failure_record_path: learningArtifacts.failureRecordPath,
      proof_status_path: proofArtifacts.proofStatusPath,
      report_path: proofArtifacts.reportPath,
      failure: learningArtifacts.record,
    };
    printJsonOrHuman(
      payload,
      formatLearningFailureHuman(learningArtifacts.record),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

function handleLearnInspect(
  artifactId: string,
  options: { json?: boolean; learningRoot?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, "learning");
    const result = readLearningArtifact({
      id: artifactId,
      learningRoot,
    });
    const artifact = result.artifact;
    const payload =
      artifact.kind === "failure"
        ? {
            status: "ok",
            learning_root: learningRoot,
            artifact_type: "failure",
            artifact_path: artifact.path,
            failure: artifact.record,
          }
        : artifact.kind === "lesson"
          ? {
              status: "ok",
              learning_root: learningRoot,
              artifact_type: "lesson",
              artifact_path: artifact.path,
              lesson: artifact.record,
            }
          : artifact.kind === "eval"
            ? {
                status: "ok",
                learning_root: learningRoot,
                artifact_type: "eval",
                artifact_path: artifact.path,
                eval: artifact.record,
              }
            : {
                status: "ok",
                learning_root: learningRoot,
                artifact_type: "mutation",
                artifact_path: artifact.path,
                mutation: artifact.record,
              };
    const human =
      artifact.kind === "failure"
        ? formatLearningFailureHuman(artifact.record)
        : artifact.kind === "lesson"
          ? formatLessonCandidateHuman(artifact.record)
          : artifact.kind === "eval"
            ? formatLessonEvalHuman(artifact.record)
            : formatMutationPackageHuman(artifact.record);
    printJsonOrHuman(payload, human, options.json === true);
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

function handleLearnPropose(
  failureId: string,
  options: { json?: boolean; learningRoot?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, "learning");
    const result = writeLessonCandidate({
      failureId,
      learningRoot,
    });
    const payload = {
      status: "ok",
      learning_root: learningRoot,
      lesson_candidate_path: result.lessonCandidatePath,
      lesson: result.lesson,
    };
    printJsonOrHuman(
      payload,
      formatLessonCandidateHuman(result.lesson),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

function handleLearnTest(
  lessonId: string,
  options: { json?: boolean; learningRoot?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, "learning");
    const result = testLessonCandidate({
      lessonId,
      learningRoot,
    });
    const payload = {
      status: result.evalRecord.status,
      learning_root: learningRoot,
      eval_record_path: result.evalRecordPath,
      eval: result.evalRecord,
    };
    printJsonOrHuman(
      payload,
      formatLessonEvalHuman(result.evalRecord),
      options.json === true,
    );
    if (result.evalRecord.status !== "passed") {
      process.exit(1);
    }
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

function handleLearnPromote(
  lessonId: string,
  options: { json?: boolean; learningRoot?: string; shadow?: boolean },
): void {
  try {
    if (options.shadow !== true) {
      throw new Error(
        "Only shadow promotion is supported. Re-run with --shadow.",
      );
    }
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, "learning");
    const result = promoteLessonToShadow({
      lessonId,
      learningRoot,
    });
    const payload = {
      status: "ok",
      learning_root: learningRoot,
      active_lesson_path: result.activeLessonPath,
      lesson: result.lesson,
    };
    printJsonOrHuman(
      payload,
      formatLessonCandidateHuman(result.lesson),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

function handleLearnPackage(
  lessonId: string,
  options: { json?: boolean; learningRoot?: string; target?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, "learning");
    const target = options.target ?? "project-verifier-contract";
    const result = generateMutationPackage({
      lessonId,
      learningRoot,
      target,
      repoRoot: BABEL_ROOT,
    });
    const payload = {
      status: "ok",
      learning_root: learningRoot,
      mutation_package_dir: result.mutationPackageDir,
      mutation_package_path: result.mutationPackagePath,
      mutation: result.mutationPackage,
    };
    printJsonOrHuman(
      payload,
      formatMutationPackageHuman(result.mutationPackage),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}

export function registerCoreLearningCommands(program: Command): void {
const modelsCommand = program
    .command("models")
    .description("Inspect and ping configured model backends")
    .addHelpText(
      "after",
      `
Examples:
  $ babel models list
  $ babel models ping
  $ babel models ping --model deepseek-v4-flash-openrouter --json

Notes:
  - List shows the active model, provider route, context/cost, and fallback chain.
  - Ping validates the configured key, policy route, provider reachability, and JSON response parsing.
  - Disabled or policy-blocked models fail before making a provider request.
`,
    )
    .action(() => {
      modelsCommand.help();
    });

modelsCommand
    .command("list")
    .description("Show the active model, route detail, and configured backends")
    .action(() => {
      const snapshot = resolveModelSnapshot();
      if (!snapshot) {
        console.log("Model policy could not be resolved. Run `babel doctor` for details.");
        return;
      }
      console.log(renderModelDetail(snapshot));
      console.log(renderAvailableModelsTable());
    });

modelsCommand
    .command("ping")
    .description("Ping one configured model backend with a tiny JSON request")
    .option(
      "--model <key>",
      "Model backend key to ping (default: OpenRouter DeepSeek Flash)",
      "deepseek-v4-flash-openrouter",
    )
    .option(
      "--i-authorize-live",
      "Required before making a live provider request",
    )
    .option(
      "--allow-expensive",
      "Approve an expensive or policy-blocked backend for this run",
    )
    .option(
      "--evidence-dir <path>",
      "Persist a redacted C0 model-ping receipt under this directory",
    )
    .option("--json", "Emit structured JSON only")
    .action(
      async (options: {
        model?: string;
        json?: boolean;
        allowExpensive?: boolean;
        iAuthorizeLive?: boolean;
        evidenceDir?: string;
      }) => {
        if (options.iAuthorizeLive !== true) {
          throw new Error(
            "Live model ping requires explicit operator authorization; re-run with --i-authorize-live.",
          );
        }
        validateRuntimeEnvForCommand({ json: options.json === true });
        await handleModelsPing(options);
      },
    );

program
    .command("prove")
    .description(
      "Prove whether a Babel run earned its completion claim from evidence",
    )
    .argument("[run]", "Run directory or latest", "latest")
    .option("--last", "Use latest run pointer")
    .option("--run <run>", "Run directory or latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--json", "Emit structured JSON only")
    .addHelpText(
      "after",
      `
Examples:
  $ babel prove --last
  $ babel prove latest
  $ babel prove <run_dir> --json

Notes:
  - Writes proof_status.json and BABEL_RUN_REPORT.md into the run directory.
  - Defaults conservatively when required proof artifacts are missing.
`,
    )
    .action(
      (
        runArg: string | undefined,
        options: {
          last?: boolean;
          run?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        handleProofReport(runArg, options);
      },
    );

const learnCommand = program
    .command("learn")
    .description("Create reviewed learning artifacts from Babel run evidence")
    .addHelpText(
      "after",
      `
Examples:
  $ babel learn from-run --last
  $ babel learn from-run <run_dir> --json
  $ babel learn propose <failure-id> --json
  $ babel learn test <lesson-id> --json
  $ babel learn promote <lesson-id> --shadow --json
  $ babel learn package <lesson-id> --target project-verifier-contract --json
  $ babel learn inspect <artifact-id>

Notes:
  - P4-P7 propose, test, shadow-promote, and package review artifacts only.
  - P7 mutation packages are review-only and do not apply patches.
  - It does not mutate prompts, policies, verifier contracts, executor behavior, or tool permissions.
`,
    )
    .action(() => {
      learnCommand.help({ error: false });
    });

learnCommand
    .command("from-run")
    .description("Create a structured learning failure record from a Babel run")
    .argument("[run]", "Run directory, run id, or latest", "latest")
    .option("--last", "Use latest run pointer")
    .option("--run <run>", "Run directory, run id, or latest")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .option("--learning-root <path>", "Directory for learning artifacts")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        runArg: string | undefined,
        options: {
          last?: boolean;
          run?: string;
          project?: string;
          learningRoot?: string;
          json?: boolean;
        },
      ) => {
        handleLearnFromRun(runArg, options);
      },
    );

learnCommand
    .command("propose")
    .description(
      "Create a scoped lesson candidate from a learning failure record",
    )
    .argument(
      "<failure-id>",
      "Failure record id, run id, or direct .failure.json path",
    )
    .option("--learning-root <path>", "Directory for learning artifacts")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        failureId: string,
        options: { learningRoot?: string; json?: boolean },
      ) => {
        handleLearnPropose(failureId, options);
      },
    );

learnCommand
    .command("test")
    .description(
      "Run the static stored-evidence eval gate for a lesson candidate",
    )
    .argument("<lesson-id>", "Lesson candidate id or direct candidate path")
    .option("--learning-root <path>", "Directory for learning artifacts")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        lessonId: string,
        options: { learningRoot?: string; json?: boolean },
      ) => {
        handleLearnTest(lessonId, options);
      },
    );

learnCommand
    .command("promote")
    .description("Promote a passing lesson candidate to advisory shadow mode")
    .argument("<lesson-id>", "Lesson candidate id or direct candidate path")
    .option("--shadow", "Promote to advisory shadow mode")
    .option("--learning-root <path>", "Directory for learning artifacts")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        lessonId: string,
        options: { shadow?: boolean; learningRoot?: string; json?: boolean },
      ) => {
        handleLearnPromote(lessonId, options);
      },
    );

learnCommand
    .command("package")
    .description(
      "Generate a review-only mutation package from a passing project lesson",
    )
    .argument("<lesson-id>", "Lesson candidate id or direct candidate path")
    .requiredOption(
      "--target <target>",
      "Mutation target type: project-verifier-contract or project-overlay",
    )
    .option("--learning-root <path>", "Directory for learning artifacts")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        lessonId: string,
        options: { target?: string; learningRoot?: string; json?: boolean },
      ) => {
        handleLearnPackage(lessonId, options);
      },
    );

learnCommand
    .command("inspect")
    .description(
      "Read a learning failure, lesson candidate, shadow lesson, eval record, or mutation package",
    )
    .argument(
      "<artifact-id>",
      "Failure id, lesson id, mutation id, or direct learning artifact path",
    )
    .option("--learning-root <path>", "Directory for learning artifacts")
    .option("--json", "Emit structured JSON only")
    .action(
      (
        artifactId: string,
        options: { learningRoot?: string; json?: boolean },
      ) => {
        handleLearnInspect(artifactId, options);
      },
    );

const evidenceCommand = program
    .command("evidence")
    .description(
      "Show the evidence-first command surfaces and latest run pointer",
    )
    .option("--json", "Emit structured JSON only")
    .option("--project <name>", "Use latest run pointer for a specific project")
    .addHelpText(
      "after",
      `
Examples:
  $ babel evidence
  $ babel evidence open
  $ babel evidence open --run <path>
  $ babel evidence export --run <path>
  $ babel evidence --project app_test_babel
  $ babel evidence --json
`,
    )
    .action((options: { json?: boolean; project?: string }) => {
      printEvidenceStatus(options);
    });

registerEvidenceProductSubcommands(evidenceCommand);
}
