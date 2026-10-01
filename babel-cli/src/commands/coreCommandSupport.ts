import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { printJsonErrorAndExit } from "./output.js";
import { validateRuntimeEnv } from "../config/runtimeEnv.js";
import { resolveInspectRunDir } from "../inspect/loaders.js";
import { type ApprovalProfileStatus } from "../config/approvalProfiles.js";
import { BABEL_ROOT, BABEL_RUNS_DIR } from "../cli/constants.js";
import { LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS, LIVE_OPENROUTER_MODEL_ID, resolveOpenRouterDeepSeekBackendKey } from "../modelPolicy.js";
import { resolveProviderCredential } from "../runners/credentialHub.js";
import type { ProviderId } from "../runners/providerRegistry.js";
import { formatProofStatusHuman, writeProofArtifacts } from "../services/proof.js";



export function exitWithRuntimeValidationFailure(
  message: string,
  jsonOutput: boolean,
): never {
  if (jsonOutput) {
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
    console.error(`Environment check failed:\n${message}`);
  }

  process.exit(1);
}

export function validateRuntimeEnvForCommand(
  options: { json?: boolean } = {},
): void {
  try {
    validateRuntimeEnv();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithRuntimeValidationFailure(message, options.json === true);
  }
}


export function describePermissionProfile(status: ApprovalProfileStatus): {
  action: string;
  scope: string[];
  cost: string;
  approval: string;
} {
  if (status.profile === "suggest") {
    return {
      action:
        "Babel will explain and plan, but file edits and commands stay simulated.",
      scope: [
        "read project files",
        "draft plans",
        "show proposed edits without writing them",
      ],
      cost: "No local mutation cost. Remote model calls may still use configured provider credits.",
      approval: "You approve before any real edit or command run.",
    };
  }
  if (status.profile === "full-auto") {
    return {
      action:
        "Babel may edit files and run checks inside the trusted workspace without repeated prompts.",
      scope: [
        "edit in-scope project files",
        "run local verifiers such as npm test",
        "keep sandbox and provider boundaries active",
      ],
      cost: "Configured provider calls may use credits; expensive model tiers still require explicit opt-in.",
      approval:
        "Only outside-workspace, network, dependency, or high-cost boundaries should interrupt the flow.",
    };
  }
  return {
    action:
      "Babel may edit files and run local checks inside the selected project.",
    scope: [
      "edit in-scope project files",
      "run local verifiers such as npm test",
      "write recovery evidence for failures",
    ],
    cost: "Configured provider calls may use credits; expensive model tiers still require explicit opt-in.",
    approval: "Trusted workspace work should not ask redundant approvals.",
  };
}

export function buildApprovalProfilePayload(
  status: ApprovalProfileStatus,
): Record<string, unknown> {
  const userTerms = describePermissionProfile(status);
  return {
    action: userTerms.action,
    scope: userTerms.scope,
    cost: userTerms.cost,
    approval: userTerms.approval,
    profile: status.profile,
    runtimeMode: status.runtimeMode,
    dryRun: status.dryRun,
    profilePath: status.profilePath,
  };
}


export function resolveProofRunArg(
  runArg: string | undefined,
  options: { last?: boolean; run?: string },
): string {
  if (options.last === true) {
    return "latest";
  }
  return options.run ?? runArg ?? "latest";
}


export function resolveProofRunDir(
  runArg: string | undefined,
  options: { last?: boolean; run?: string; project?: string },
): string {
  const requested = resolveProofRunArg(runArg, options);
  const resolved = resolveInspectRunDir({
    run: requested,
    project: options.project,
    babelRunsDir: BABEL_RUNS_DIR,
  });
  if (existsSync(resolved)) {
    return resolved;
  }
  if (!requested.includes("/") && !requested.includes("\\")) {
    const runIdCandidate = join(BABEL_RUNS_DIR, requested);
    if (existsSync(runIdCandidate)) {
      return runIdCandidate;
    }
  }
  return resolved;
}


export function handleProofReport(
  runArg: string | undefined,
  options: { run?: string; project?: string; last?: boolean; json?: boolean },
): void {
  try {
    const resolvedRunDir = resolveProofRunDir(runArg, options);
    const artifacts = writeProofArtifacts(resolvedRunDir);
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "ok",
            proof_status_path: artifacts.proofStatusPath,
            report_path: artifacts.reportPath,
            proof: artifacts.proof,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${formatProofStatusHuman(artifacts.proof)}\n`);
  } catch (err: unknown) {
    printJsonErrorAndExit(
      err instanceof Error ? err.message : String(err),
      options.json === true,
    );
  }
}


export class ActionableCommandError extends Error {
  readonly payload: Record<string, unknown>;
  readonly human: string;

  constructor(
    message: string,
    payload: Record<string, unknown>,
    human: string,
  ) {
    super(message);
    this.name = "ActionableCommandError";
    this.payload = payload;
    this.human = human;
  }
}


export function resolveRunForReadOnlyCommand(
  run: string | undefined,
  project: string | undefined,
): string {
  return resolveInspectRunDir({
    run: run ?? "latest",
    project,
    babelRunsDir: BABEL_RUNS_DIR,
  });
}

export function resolveBenchmarkProvider(
  providerInput: string,
  requestedModel?: string,
): {
  provider: ProviderId;
  apiKey: string;
  defaultModel: string;
} {
  if (providerInput !== "deepseek" && providerInput !== "openrouter") {
    throw new Error(
      `[LIVE_MODEL_POLICY] Live benchmarks support DeepSeek controls and GLM through OpenRouter; received "${providerInput}".`,
    );
  }

  const deepSeekBackend = requestedModel
    ? resolveOpenRouterDeepSeekBackendKey(requestedModel)
    : providerInput === "deepseek"
      ? "deepseek-v4-flash-openrouter"
      : null;
  const isDeepSeekControl = providerInput === "deepseek" || deepSeekBackend !== null;
  const defaultModel = isDeepSeekControl
    ? deepSeekBackend === "deepseek-v4-pro-openrouter"
      ? LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[1]
      : LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0]
    : LIVE_OPENROUTER_MODEL_ID;
  if (requestedModel && !isDeepSeekControl) {
    const isGlm = requestedModel === LIVE_OPENROUTER_MODEL_ID || requestedModel === "glm-5.3-flash";
    if (providerInput !== "openrouter" || !isGlm) {
      throw new Error(
        `[LIVE_MODEL_POLICY] OpenRouter live benchmarks accept only ${LIVE_OPENROUTER_MODEL_ID} or the approved DeepSeek control route; received "${requestedModel}".`,
      );
    }
  }
  if (providerInput === "deepseek" && requestedModel && !deepSeekBackend) {
    throw new Error(
      `[LIVE_MODEL_POLICY] DeepSeek live controls accept only the approved DeepSeek v4 Flash/Pro selectors; received "${requestedModel}".`,
    );
  }
  // DeepSeek controls intentionally use the OpenRouter credential and
  // endpoint. The direct DEEPSEEK_API_KEY path is not a live benchmark path.
  const provider = "openrouter" as const;
  const apiKey = resolveProviderCredential(provider);
  if (!apiKey) {
    throw new Error(
      "[LIVE_MODEL_POLICY] Live benchmarks require OPENROUTER_API_KEY before execution.",
    );
  }
  return { provider, apiKey, defaultModel };
}


export function parsePositiveIntOption(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveBenchmarkAnalyzeRun(
  raw: string,
  options: { benchmarksRoot?: string; suite: string },
): string {
  if (raw !== "latest") {
    return resolve(raw);
  }
  const workspaceRoot = dirname(BABEL_ROOT);
  const benchmarksRoot = resolve(
    options.benchmarksRoot ?? join(workspaceRoot, "benchmarks"),
  );
  const resultRoot = join(benchmarksRoot, "runs", "terminal-bench-2");
  if (!existsSync(resultRoot)) {
    throw buildMissingBenchmarkResultRootError({
      benchmarksRoot,
      resultRoot,
      suite: options.suite,
    });
  }
  const latest = collectBenchmarkResultPaths(resultRoot)
    .map((path) => ({
      path,
      mtimeMs: statSync(path).mtimeMs,
      metadata: readBenchmarkResultMetadata(path),
    }))
    .filter((entry) => entry.metadata.isJobResult)
    .filter(
      (entry) =>
        entry.metadata.suite === null || entry.metadata.suite === options.suite,
    )
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error(
      `No Terminal-Bench result.json files found for suite ${options.suite} under ${resultRoot}`,
    );
  }
  return latest.path;
}


export function buildMissingBenchmarkResultRootError(input: {
  benchmarksRoot: string;
  resultRoot: string;
  suite: string;
}): ActionableCommandError {
  const loopCommand = `node .\\babel-cli\\dist\\index.js benchmark loop --readiness full --suite ${input.suite} --json`;
  const analyzeCommand = `node .\\babel-cli\\dist\\index.js benchmark analyze latest --suite ${input.suite} --json`;
  const payload = {
    status: "blocked",
    reason: "terminal_bench_result_root_missing",
    error: `Terminal-Bench result root not found: ${input.resultRoot}`,
    benchmarks_root: input.benchmarksRoot,
    expected_result_root: input.resultRoot,
    suite: input.suite,
    next: [
      "Create or configure the Terminal-Bench results root.",
      "Run a full benchmark loop to establish the baseline.",
      "Re-run benchmark analyze latest after the result.json exists.",
    ],
    commands: {
      run_full_baseline: loopCommand,
      analyze_latest: analyzeCommand,
    },
  };
  const human = [
    "Benchmark analysis blocked",
    `Reason: Terminal-Bench result root is missing.`,
    `Expected: ${input.resultRoot}`,
    "",
    "Next:",
    `- ${payload.next[0]}`,
    `- ${loopCommand}`,
    `- ${analyzeCommand}`,
  ].join("\n");
  return new ActionableCommandError(String(payload.error), payload, human);
}


export function collectBenchmarkResultPaths(
  dir: string,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectBenchmarkResultPaths(fullPath, out);
    } else if (entry.name === "result.json") {
      out.push(fullPath);
    }
  }
  return out;
}


export function readBenchmarkResultMetadata(path: string): {
  suite: string | null;
  isJobResult: boolean;
} {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const suite = record["suite"];
      return {
        suite: typeof suite === "string" ? suite : null,
        isJobResult:
          record["summary"] !== undefined &&
          (Array.isArray(record["results"]) || Array.isArray(record["trials"])),
      };
    }
  } catch {
    return { suite: null, isJobResult: false };
  }
  return { suite: null, isJobResult: false };
}
