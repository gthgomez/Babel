import { mandatoryVerifierProse } from '../config/verifierIntent.js';
/**
 * Verifier command extraction + R9 tamper guard helpers (from ChatEngine).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeVerifierDependencyHashes, hashVerifierTrackedContent } from './verifierIntegrity.js';
import type { StallState } from './stallDetector.js';

/** R3b: Extract a verifier command pattern from the task string. */
export function extractVerifierCommand(task: string | undefined): string | null {
  if (!task) return null;
  task = mandatoryVerifierProse(task);

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
  additionalVerifierCommands: readonly string[] = [],
): void {
  const commands = [...new Set([
    ...(task ? [extractVerifierCommand(task)].filter((value): value is string => Boolean(value)) : []),
    ...additionalVerifierCommands,
  ])];
  if (commands.length === 0) return;
  for (const [file, hash] of Object.entries(computeVerifierDependencyHashes(projectRoot, commands))) {
    hashes.set(file, hash);
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

/** Full content digest. Identical bytes still dedupe; a same-length interior edit does not. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
