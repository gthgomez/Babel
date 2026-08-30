import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeOpenRouterMetadataSnapshot } from "../src/intelligence/openrouterMetadata.js";
import { fetchAndPersistOpenRouterModelEvidence } from "../src/intelligence/providerEvidence.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

const models = [
  argument("--glm") ?? "z-ai/glm-5.3-flash",
  argument("--deepseek") ?? "deepseek/deepseek-v4-flash-0731",
];
const output = resolve(
  argument("--out") ?? "artifacts/model-intelligence/openrouter-latest.json",
);
const retrievedAt = new Date().toISOString();
const normalizerSourceHash = createHash("sha256")
  .update(
    await readFile(
      new URL("../src/intelligence/openrouterMetadata.ts", import.meta.url),
    ),
  )
  .digest("hex");
const snapshots = [];
for (const requestedModel of models) {
  const captured = await fetchAndPersistOpenRouterModelEvidence({
    requestedModel,
    directory: dirname(output),
    normalizerSourceHash,
    observedAt: retrievedAt,
  });
  snapshots.push(captured.normalized);
}
await mkdir(dirname(output), { recursive: true });
await writeOpenRouterMetadataSnapshot({
  path: output,
  retrievedAt,
  models: snapshots,
});
process.stdout.write(
  `${JSON.stringify({ output, retrievedAt, models: snapshots.map((item) => item.resolvedModel) })}\n`,
);
