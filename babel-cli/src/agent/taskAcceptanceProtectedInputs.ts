/**
 * C2 protected-input surface for designated regression witnesses.
 *
 * When a preservation criterion binds to its own designated test command, the
 * task's own text makes the already-present tests and their script definitions
 * protected inputs: the candidate must never weaken, delete or re-point them.
 * This module derives the *narrowly declared* protected set at freeze time:
 *
 * - `package.json` — the script-definition surface any `npm run …` witness
 *   resolves through. Protecting it defeats replacing a designated script
 *   with an exit-zero stand-in.
 * - Resolvable test files the designated script names directly (existing
 *   paths in the script string). Discovery is best-effort; inputs the script
 *   does not statically name stay explicit and are NOT silently protected.
 *
 * Ordinary tasks without a designated witness are unchanged.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { designatedWitnessCommands, hasDesignatedRegressionWitnessBinding } from './taskAcceptanceExecutableBinding.js';
import type { TaskAcceptanceMeaning } from './taskAcceptanceMeaning.js';

export interface ProtectedInputFs {
  readFile: (path: string) => string | null;
  exists: (path: string) => boolean;
}

export const defaultProtectedInputFs: ProtectedInputFs = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
};

/** Path-shaped tokens in a script string that look like test/spec files. */
const TEST_FILE_TOKEN_RE = /[\w@./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/g;

/**
 * The protected input paths for a task with a designated regression witness:
 * package.json plus the test files the designated scripts statically name and
 * that exist in the project. No witness → empty set (ordinary tasks unchanged).
 */
export function designatedWitnessProtectedInputs(
  projectRoot: string,
  meaning: TaskAcceptanceMeaning,
  fs: ProtectedInputFs = defaultProtectedInputFs,
): string[] {
  if (!hasDesignatedRegressionWitnessBinding(meaning)) return [];
  const protectedPaths = new Set<string>(['package.json']);
  const packageJson = fs.readFile(join(projectRoot, 'package.json'));
  if (packageJson) {
    let scripts: Record<string, unknown> | undefined;
    try {
      scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts;
    } catch {
      scripts = undefined;
    }
    for (const command of designatedWitnessCommands(meaning)) {
      // Only npm-script witnesses have a resolvable script surface here.
      const runMatch = command.match(/^npm\s+(?:run\s+)?([\w:.-]+)\s*$/);
      const script = typeof scripts?.[runMatch?.[1] ?? ''] === 'string'
        ? (scripts[runMatch![1]!] as string)
        : null;
      if (!script) continue;
      for (const token of script.matchAll(TEST_FILE_TOKEN_RE)) {
        const relative = token[0].replace(/\\/g, '/');
        if (fs.exists(join(projectRoot, relative))) protectedPaths.add(relative);
      }
    }
  }
  return [...protectedPaths].sort();
}
