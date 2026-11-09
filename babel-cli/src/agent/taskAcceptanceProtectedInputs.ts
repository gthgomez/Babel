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
import { designatedWitnessCommands, explicitCriterionVerifierCommands, hasDesignatedRegressionWitnessBinding } from './taskAcceptanceExecutableBinding.js';
import { explicitNodeTestFileArgs } from './completionGatePolicy.js';
import type { TaskAcceptanceMeaning } from './taskAcceptanceMeaning.js';

export interface ProtectedInputFs {
  readFile: (path: string) => string | null;
  exists: (path: string) => boolean;
}

/** Existing exact Node test files that can be frozen at task admission. */
export function existingNodeVerifierInputFiles(
  projectRoot: string,
  meaning: TaskAcceptanceMeaning,
  fs: ProtectedInputFs = defaultProtectedInputFs,
  trustedVerifierCommands: readonly string[] = [],
): string[] {
  const commands = [...new Set([
    ...(hasDesignatedRegressionWitnessBinding(meaning) ? designatedWitnessCommands(meaning) : []),
    ...explicitCriterionVerifierCommands(meaning),
    ...trustedVerifierCommands,
  ])];
  const files = new Set<string>();
  for (const command of commands) {
    const inputs = explicitNodeTestFileArgs(command);
    if (!inputs?.length) continue;
    for (const token of inputs) {
      const relative = token.replace(/\\/g, '/');
      if (relative.startsWith('../') || /^[A-Za-z]:|^\//.test(relative) || /(^|\/)\.\.(\/|$)/.test(relative)) continue;
      if (fs.exists(join(projectRoot, relative))) files.add(relative);
    }
  }
  return [...files].sort();
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
 * Freeze pre-existing verifier inputs for explicitly designated witnesses and
 * task-authored criterion links. Unknown command forms stay unexpanded.
 */
export function designatedWitnessProtectedInputs(
  projectRoot: string,
  meaning: TaskAcceptanceMeaning,
  fs: ProtectedInputFs = defaultProtectedInputFs,
): string[] {
  const commands = [...new Set([
    ...(hasDesignatedRegressionWitnessBinding(meaning) ? designatedWitnessCommands(meaning) : []),
    ...explicitCriterionVerifierCommands(meaning),
  ])];
  if (commands.length === 0) return [];
  const protectedPaths = new Set<string>();
  const packageJson = fs.readFile(join(projectRoot, 'package.json'));
  if (commands.some(command => /^npm\s+(?:run\s+)?[\w:.-]+\s*$/.test(command))) protectedPaths.add('package.json');
  if (hasDesignatedRegressionWitnessBinding(meaning) || commands.some(command => /^npm\s+(?:run\s+)?[\w:.-]+\s*$/.test(command))) {
    if (packageJson) {
    let scripts: Record<string, unknown> | undefined;
    try {
      scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts;
    } catch {
      scripts = undefined;
    }
    for (const command of commands) {
      // Only npm-script witnesses have a resolvable script surface here.
      const runMatch = command.match(/^npm\s+(?:run\s+)?([\w:.-]+)\s*$/);
      const script = typeof scripts?.[runMatch?.[1] ?? ''] === 'string'
        ? (scripts[runMatch![1]!] as string)
        : null;
      if (!script) continue;
      for (const token of script.matchAll(TEST_FILE_TOKEN_RE)) {
        const relative = token[0].replace(/\\/g, '/');
        // Containment: never protect paths escaping the project root.
        if (relative.startsWith('../') || /^[A-Za-z]:|^\//.test(relative) || /(^|\/)\.\.(\/|$)/.test(relative)) continue;
        if (fs.exists(join(projectRoot, relative))) protectedPaths.add(relative);
      }
    }
    }
  }
  for (const path of existingNodeVerifierInputFiles(projectRoot, meaning, fs)) protectedPaths.add(path);
  return [...protectedPaths].sort();
}
