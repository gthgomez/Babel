/**
 * Verifier command extraction + R9 tamper guard helpers (from ChatEngine).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashVerifierTrackedContent } from './verifierIntegrity.js';
import type { StallState } from './stallDetector.js';

/** R3b: Extract a verifier command pattern from the task string. */
export function extractVerifierCommand(task: string | undefined): string | null {
  if (!task) return null;

  const patterns = [
    /run\s+(npm test|pytest|go test\s+\S+|cargo test|make test|npx jest|npx mocha)/i,
    /execute\s+(npm test|pytest|go test\s+\S+|cargo test|make test)/i,
    /\b(go test(?:\s+\S+)*)\b/,
    /\b(npm run \S+)\b/,
    /\b(npm test)\b/,
    /\b(pytest)\b/,
    /\b(cargo test)\b/,
    /\b(make test)\b/,
    /\b(npx \S+)\b/,
  ];

  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match) {
      return match[1] ?? match[0];
    }
  }
  return null;
}

/**
 * R9: Seed verifier dependency hashes at session start.
 * Mutates `hashes` map in place.
 */
export function initializeVerifierDependencyHashes(
  task: string | undefined,
  projectRoot: string,
  hashes: Map<string, string>,
): void {
  if (!task) return;
  const verifierCmd = extractVerifierCommand(task);
  if (!verifierCmd) return;

  const filesToHash = new Set<string>();
  let packageJson: Record<string, unknown> | null = null;

  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      packageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      /* skip */
    }
  }

  const npmRunMatch = verifierCmd.match(/^npm\s+(?:run\s+)?(\S+)/);
  if (npmRunMatch && packageJson) {
    filesToHash.add('package.json');
    const scriptName = npmRunMatch[1]!;
    const scripts = packageJson['scripts'] as Record<string, string> | undefined;
    const scriptCmd = scripts?.[scriptName];
    if (scriptCmd) {
      const scriptFileRefs = scriptCmd.match(/([^\s"'`]+\.(?:mjs|js|cjs|ts))\b/g);
      if (scriptFileRefs) {
        for (const f of scriptFileRefs) filesToHash.add(f);
      }
    }
  }

  const nodeFileMatch = verifierCmd.match(
    /^node\s+(?!(?:-e|--test|--check)\b)(\S+)/,
  );
  if (nodeFileMatch?.[1]) filesToHash.add(nodeFileMatch[1]);

  const fileRefs = verifierCmd.match(/([^\s"'`]+\.(?:mjs|js|sh|bat|cmd))\b/g);
  if (fileRefs) {
    for (const f of fileRefs) {
      if (!f.startsWith('-')) filesToHash.add(f);
    }
  }

  filesToHash.add('package.json');

  for (const file of filesToHash) {
    const absPath = join(projectRoot, file);
    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath);
        hashes.set(file, hashVerifierTrackedContent(file, content));
      } catch {
        /* permission error — skip */
      }
    }
  }
}

export interface VerifierTamperState {
  verifierDependencyHashes: Map<string, string>;
  verifierTampered: boolean;
  tamperCount: number;
  tamperedThisTurn: boolean;
}

/** R9: Check write to filePath against verifier dependency hashes. */
export function checkVerifierTamper(
  filePath: string,
  projectRoot: string,
  state: VerifierTamperState,
): string | null {
  if (state.verifierDependencyHashes.size === 0) return null;

  const absPath = filePath.startsWith(projectRoot)
    ? filePath
    : join(projectRoot, filePath);

  for (const [relPath, originalHash] of state.verifierDependencyHashes) {
    const depAbsPath = join(projectRoot, relPath);
    if (absPath !== depAbsPath) continue;

    try {
      const currentContent = readFileSync(absPath);
      const currentHash = hashVerifierTrackedContent(relPath, currentContent);
      if (currentHash !== originalHash) {
        state.verifierTampered = true;
        state.tamperCount++;
        state.tamperedThisTurn = true;
        const escalation =
          state.tamperCount >= 3
            ? `\n\nThis is your ${state.tamperCount}rd verifier integrity violation. ` +
              `The session will be terminated with a BLOCKED outcome. ` +
              `You must declare BLOCKED with evidence of what you checked.`
            : state.tamperCount >= 2
              ? `\n\nThis is your 2nd verifier integrity violation. ` +
                `You MUST now declare your status: DONE (task complete), ` +
                `BLOCKED (task impossible, with evidence), ` +
                `or NEED: <specific thing needed>. You may no longer modify verifier files.`
              : `\n\nIf the task cannot be completed without modifying verifier files, ` +
                `declare BLOCKED with evidence of what you checked.`;
        return (
          `⚠️ VERIFIER INTEGRITY WARNING: You modified \`${relPath}\`, ` +
          `which is a dependency of the verifier command. The verifier can no longer ` +
          `be trusted as an independent check. This modification has been recorded ` +
          `and will be flagged in the final assessment.${escalation}`
        );
      }
      state.verifierDependencyHashes.set(relPath, currentHash);
    } catch {
      /* file may not exist — skip */
    }
    break;
  }
  return null;
}

/** R9: Escalate stall intervention after verifier tampering. */
export function applyTamperEscalation(
  state: Pick<VerifierTamperState, 'tamperedThisTurn' | 'tamperCount'>,
  stallState: StallState,
): string | null {
  if (!state.tamperedThisTurn) return null;

  if (state.tamperCount >= 3) {
    return '__TAMPER_AUTO_BLOCKED__';
  }

  if (state.tamperCount >= 2) {
    stallState.interventionLevel = Math.max(stallState.interventionLevel, 3);
    return (
      `SYSTEM: Verifier integrity violation #${state.tamperCount}. ` +
      `The escalating stall intervention has been accelerated. ` +
      `You MUST declare your status now.`
    );
  }

  return null;
}

/** SHA-256-ish content fingerprint for caching (fast, not cryptographic). */
export function hashContent(content: string): string {
  const len = content.length;
  const prefix = content.substring(0, 100);
  const suffix = content.substring(Math.max(0, len - 100));
  return `${len}:${prefix}:${suffix}`;
}
