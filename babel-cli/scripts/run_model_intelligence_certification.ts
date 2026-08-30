import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { writeVerificationResult } from "../src/intelligence/verification.js";

const repo = resolve(process.cwd());
const outputArgIndex = process.argv.indexOf("--output");
const output = resolve(
  outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
    ? process.argv[outputArgIndex + 1]!
    : "../artifacts/model-intelligence/verification",
);
const checks = [
  {
    name: "typecheck",
    command: "npm run typecheck",
    args: ["run", "typecheck"],
  },
  {
    name: "focused-tests",
    command:
      "npm exec -- tsx --no-warnings=ExperimentalWarning --test src/intelligence/intelligence.test.ts src/intelligence/evidenceCertification.test.ts",
    args: [
      "exec",
      "--",
      "tsx",
      "--no-warnings=ExperimentalWarning",
      "--test",
      "src/intelligence/intelligence.test.ts",
      "src/intelligence/evidenceCertification.test.ts",
    ],
  },
  {
    name: "format",
    command:
      "npm exec -- prettier --check src/intelligence scripts/snapshot_openrouter_metadata.ts scripts/reconcile_model_intelligence_history.ts scripts/build_model_intelligence_review_package.ts scripts/run_model_intelligence_certification.ts",
    args: [
      "exec",
      "--",
      "prettier",
      "--check",
      "src/intelligence",
      "scripts/snapshot_openrouter_metadata.ts",
      "scripts/reconcile_model_intelligence_history.ts",
      "scripts/build_model_intelligence_review_package.ts",
      "scripts/run_model_intelligence_certification.ts",
    ],
  },
];
const head = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: resolve(repo, ".."),
  encoding: "utf8",
}).stdout.trim();
await mkdir(output, { recursive: true });
const results: Array<{
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  exitCode: number;
}> = [];
for (const check of checks) {
  const result = spawnSync("npm.cmd", check.args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  const persisted = await writeVerificationResult({
    directory: output,
    name: check.name,
    command: check.command,
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    headSha: head,
  });
  results.push({ ...persisted, exitCode: result.status ?? 1 });
}
process.stdout.write(
  JSON.stringify({ output, checks: results }, null, 2) + "\n",
);
if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
