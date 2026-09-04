import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const sourceRoot = join(import.meta.dirname, "..");
const authorityLane = new Set([
  "authority/trustedExecutionPort.ts",
  "authority/trustedExecutionSupervisor.ts",
  "evidence/trustedExecutionIdentity.ts",
]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = join(root, entry);
    const metadata = statSync(absolute);
    if (metadata.isDirectory()) files.push(...sourceFiles(absolute));
    else if (absolute.endsWith(".ts") && !absolute.endsWith(".test.ts"))
      files.push(absolute);
  }
  return files;
}

test("trusted read-port factory is private to the trusted authority lane", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, file).replaceAll("\\", "/");
    if (authorityLane.has(relativePath)) continue;
    const source = readFileSync(file, "utf8");
    if (
      source.includes("createTrustedExecutionReadPortInternal") ||
      /(?:from|import)\s*['"][^'"]*trustedExecutionPort\.js['"]/.test(source)
    ) {
      violations.push(relativePath);
    }
  }
  assert.deepEqual(violations, []);
});

test("trusted read-port authority module is not exported by the CLI entrypoint", () => {
  const entrypoint = readFileSync(join(sourceRoot, "index.ts"), "utf8");
  assert.doesNotMatch(
    entrypoint,
    /trustedExecution(?:Port|Supervisor|Identity)/,
  );
});
