/**
 * compiler.ts — Babel Context Compiler and Typed Stack Resolver
 *
 * Reads and concatenates the Markdown prompt files listed in an Orchestrator
 * manifest, then appends the user's raw task at the end. It also resolves
 * v9 typed instruction stacks against `prompt_catalog.yaml` into a compiled
 * prompt manifest that remains backward compatible with legacy consumers.
 *
 * Design notes:
 *   - Synchronous reads: the compiler runs once at pipeline startup, not in a
 *     hot loop. Sync I/O keeps the call sites simple and the stack easy to read.
 *   - Clear file boundaries let the receiving model (and a human auditor) know
 *     exactly which layer contributed which instruction.
 *   - The task context block is always last so the model's recency bias works
 *     in our favour.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type {
  OrchestratorManifest,
} from './schemas/agentContracts.js';
import { resolveInstructionStackManifest as resolveInstructionStackManifestInternal } from './control-plane/stackResolver.js';

const FILE_BOUNDARY_OPEN  = (name: string) => `\n\n--- START OF FILE: ${name} ---\n\n`;
const FILE_BOUNDARY_CLOSE = (name: string) => `\n\n--- END OF FILE: ${name} ---`;
const TASK_BOUNDARY        = '\n\n--- TASK CONTEXT ---\n\n';

/**
 * Compiles an ordered list of Markdown prompt files plus a raw task description
 * into a single context string suitable for LLM submission.
 *
 * @param manifestPaths - Ordered array of .md file paths (absolute or CWD-relative).
 *                        Files are read in the order given; order must match the
 *                        `load_order` values from the OrchestratorManifest.
 * @param taskContext   - The user's raw task string, injected at the very end so
 *                        the model reads layered instructions before the request.
 * @returns A single compiled string ready to be sent to a ClaudeCliRunner or
 *          ApiFallbackRunner.
 * @throws  {Error} If `manifestPaths` is empty, or if any file cannot be read.
 */
export function compileContext(
  manifestPaths: string[],
  taskContext:   string,
): string {
  if (manifestPaths.length === 0) {
    throw new Error('[compiler] manifestPaths must not be empty.');
  }
  if (!taskContext.trim()) {
    throw new Error('[compiler] taskContext must not be blank.');
  }

  const parts: string[] = [];

  for (const filePath of manifestPaths) {
    const name    = basename(filePath);
    // readFileSync throws with a descriptive OS error if the file is missing.
    const content = readFileSync(filePath, 'utf-8');

    parts.push(
      FILE_BOUNDARY_OPEN(name) +
      content.trimEnd() +
      FILE_BOUNDARY_CLOSE(name),
    );
  }

  parts.push(TASK_BOUNDARY + taskContext.trim() + '\n');

  return parts.join('');
}
export function resolveInstructionStackManifest(
  manifest: OrchestratorManifest,
  babelRoot: string,
): OrchestratorManifest {
  return resolveInstructionStackManifestInternal(manifest, babelRoot);
}
