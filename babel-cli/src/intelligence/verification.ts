import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface VerificationResult {
  schemaVersion: 1;
  command: string;
  exitCode: number;
  testCount: number | null;
  timestamp: string;
  headSha: string;
  stdoutArtifact: string;
  stderrArtifact: string;
}

/** Extract machine-produced Node test counts without trusting hand-written summaries. */
export function parseTestCount(output: string): number | null {
  const matches = [...output.matchAll(/(?:ℹ\s+tests|tests)\s*[:=]?\s*(\d+)/gi)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  const count = Number(last);
  return Number.isInteger(count) ? count : null;
}

/** Write raw stdout/stderr alongside the machine-readable verification result. */
export async function writeVerificationResult(input: {
  directory: string;
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  headSha: string;
  timestamp?: string;
}): Promise<{ resultPath: string; stdoutPath: string; stderrPath: string }> {
  await mkdir(input.directory, { recursive: true });
  const timestamp = input.timestamp ?? new Date().toISOString();
  const stdoutPath = join(input.directory, `${input.name}.stdout.log`);
  const stderrPath = join(input.directory, `${input.name}.stderr.log`);
  const resultPath = join(input.directory, `${input.name}.json`);
  await writeFile(stdoutPath, input.stdout, "utf8");
  await writeFile(stderrPath, input.stderr ?? "", "utf8");
  const result: VerificationResult = {
    schemaVersion: 1,
    command: input.command,
    exitCode: input.exitCode,
    testCount: parseTestCount(`${input.stdout}\n${input.stderr ?? ""}`),
    timestamp,
    headSha: input.headSha,
    stdoutArtifact: stdoutPath,
    stderrArtifact: stderrPath,
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { resultPath, stdoutPath, stderrPath };
}
