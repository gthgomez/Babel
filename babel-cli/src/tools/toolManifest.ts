/**
 * Tool Manifest Loader & Validator
 *
 * Loads and validates `tool-manifest.json` at startup.
 * Provides typed accessors for the canonical tool surface.
 *
 * The manifest is the source of truth for:
 *   - Tool metadata (names, categories, descriptions, policy tags)
 *   - Input contracts (required/optional parameters with types)
 *   - Output schema (shared ToolResult shape)
 *   - Dry-run behavior and mutating classification
 *
 * Handler functions are NOT in the manifest — they are resolved
 * at runtime from the existing handler map in localTools.ts.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const ToolInputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string(),
  enum: z.array(z.string()).optional(),
});

const ToolExampleSchema = z.record(z.string(), z.unknown());

const ToolManifestEntrySchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string(),
  mutating: z.boolean(),
  dryRunBehavior: z.enum(['live', 'mocked', 'shadow_write', 'stateful']),
  policyTags: z.array(z.string()),
  input: z.object({
    required: z.array(ToolInputFieldSchema),
    optional: z.array(ToolInputFieldSchema),
  }),
  jitApproval: z.boolean().optional(),
  jitApprovalTriggers: z.array(z.string()).optional(),
  examples: z.array(ToolExampleSchema).optional(),
});

const OutputSchemaSchema = z.record(z.string(), z.unknown());

const ToolManifestSchema = z.object({
  $schema: z.string().optional(),
  manifestVersion: z.string(),
  generatedFrom: z.string().optional(),
  generatedAt: z.string().optional(),
  outputSchema: OutputSchemaSchema,
  categories: z.record(z.string(), z.string()),
  tools: z.array(ToolManifestEntrySchema),
});

// ─── Derived Types ───────────────────────────────────────────────────────────

export type ToolInputField = z.infer<typeof ToolInputFieldSchema>;
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>;
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

export interface ToolManifestSnapshot {
  name: string;
  category: string;
  description: string;
  mutating: boolean;
  dryRunBehavior: 'live' | 'mocked' | 'shadow_write' | 'stateful';
  policyTags: string[];
  input: {
    required: ToolInputField[];
    optional: ToolInputField[];
  };
  jitApproval?: boolean;
  examples?: Record<string, unknown>[];
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _manifest: ToolManifest | null = null;
let _loadError: string | null = null;

// ─── Loader ──────────────────────────────────────────────────────────────────

function resolveManifestPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, 'tool-manifest.json');
}

export function loadToolManifest(): ToolManifest {
  if (_manifest) return _manifest;

  const manifestPath = resolveManifestPath();

  let raw: unknown;
  try {
    const jsonText = readFileSync(manifestPath, 'utf-8');
    raw = JSON.parse(jsonText);
  } catch (err) {
    _loadError = `Failed to read tool manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`;
    throw new Error(_loadError);
  }

  const result = ToolManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    _loadError = `Invalid tool manifest:\n${issues}`;
    throw new Error(_loadError);
  }

  _manifest = result.data;
  return _manifest;
}

// ─── Accessors ───────────────────────────────────────────────────────────────

export function getManifestSnapshot(): ToolManifestSnapshot[] {
  const manifest = loadToolManifest();
  return manifest.tools.map((entry) => ({
    name: entry.name,
    category: entry.category,
    description: entry.description,
    mutating: entry.mutating,
    dryRunBehavior: entry.dryRunBehavior,
    policyTags: [...entry.policyTags],
    input: {
      required: entry.input.required.map((f) => ({ ...f })),
      optional: entry.input.optional.map((f) => ({ ...f })),
    },
    ...(entry.jitApproval !== undefined ? { jitApproval: entry.jitApproval } : {}),
    ...(entry.examples ? { examples: entry.examples } : {}),
  }));
}

export function getManifestTool(name: string): ToolManifestEntry | null {
  const manifest = loadToolManifest();
  return manifest.tools.find((t) => t.name === name) ?? null;
}

export function getManifestCategories(): Record<string, string> {
  const manifest = loadToolManifest();
  return { ...manifest.categories };
}

export function getManifestVersion(): string {
  const manifest = loadToolManifest();
  return manifest.manifestVersion;
}

export function getManifestLoadError(): string | null {
  return _loadError;
}

/**
 * Reload the manifest (used by hot-reload in dev mode).
 * Clears the cached manifest so the next call to loadToolManifest() re-reads from disk.
 */
export function reloadToolManifest(): void {
  _manifest = null;
  _loadError = null;
}

/**
 * Validate that a given set of tool names matches the manifest.
 * Returns a list of discrepancies (names in code but not in manifest, and vice versa).
 */
export function validateManifestCoverage(toolNamesFromCode: string[]): {
  inCodeButNotManifest: string[];
  inManifestButNotCode: string[];
  ok: boolean;
} {
  const manifest = loadToolManifest();
  const manifestNames = new Set(manifest.tools.map((t) => t.name));
  const codeNames = new Set(toolNamesFromCode);

  const inCodeButNotManifest = [...codeNames].filter((n) => !manifestNames.has(n));
  const inManifestButNotCode = [...manifestNames].filter((n) => !codeNames.has(n));

  return {
    inCodeButNotManifest,
    inManifestButNotCode,
    ok: inCodeButNotManifest.length === 0 && inManifestButNotCode.length === 0,
  };
}
