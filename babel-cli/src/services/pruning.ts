import { readFileSync, existsSync } from 'node:fs';
import { runWithFallback } from '../execute.js';
import { PruningAnalysisSchema } from '../schemas/agentContracts.js';
import { EvidenceBundle } from '../evidence.js';
import { countTextTokens } from './tokenCounter.js';

export interface PrunedContext {
  stubs: Map<string, string>; // Path -> Summary stub
  criticalPaths: Set<string>;
}

export function isContextPruningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['BABEL_CONTEXT_PRUNING'] === 'true';
}

// ── Safety-Critical Patterns ─────────────────────────────────────────────────

const MANDATORY_CRITICAL_PATTERNS = [
  /executionProfiles/i,
  /sandbox\.(ts|js)$/i,
  /recovery\.(ts|js)$/i,
  /schemaFailureLedger/i,
  /contractEnforcement/i,
  /exactInstruction/i,
  /haltDiagnosis/i,
  /terminalStatus/i,
  /RULES_CORE/i,
  /RULES_GUARD/i,
  /Behavioral_OS/i,
  /BABEL_BIBLE/i,
];

const isMandatoryCritical = (path: string): boolean =>
  MANDATORY_CRITICAL_PATTERNS.some((p) => p.test(path));

// ── Deterministic Pruning (Fast Path) ────────────────────────────────────────

interface FileTokenInfo {
  path: string;
  tokens: number;
  sizeKb: number;
}

/**
 * Deterministic pruning heuristics. Runs BEFORE any LLM call to reduce the
 * manifest size cheaply. Files are classified as:
 *   - critical: keep in full
 *   - supplementary: stub with a one-line summary
 *
 * Heuristics (in priority order):
 *   1. Safety-critical patterns → ALWAYS critical
 *   2. Files ≤ 500 tokens → critical (small enough to keep)
 *   3. Files matching task keywords → critical
 *   4. Files > 2000 tokens without task keyword match → supplementary
 *   5. Everything else → critical (default safe)
 */
export function deterministicPrune(userRequest: string, manifestPaths: string[]): PrunedContext {
  if (manifestPaths.length <= 3) {
    return { stubs: new Map(), criticalPaths: new Set(manifestPaths) };
  }

  // Extract task keywords for relevance matching
  const taskKeywords = userRequest
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length > 3)
    .filter(
      (w) =>
        ![
          'this',
          'that',
          'with',
          'from',
          'have',
          'been',
          'were',
          'they',
          'them',
          'then',
          'when',
          'what',
          'where',
          'which',
          'would',
          'could',
          'should',
          'about',
          'into',
          'over',
          'after',
          'before',
          'under',
          'above',
          'below',
        ].includes(w),
    );

  const fileInfos: FileTokenInfo[] = [];
  for (const path of manifestPaths) {
    try {
      if (!existsSync(path)) {
        fileInfos.push({ path, tokens: 0, sizeKb: 0 });
        continue;
      }
      const content = readFileSync(path, 'utf-8');
      const tokens = countTextTokens(content);
      const sizeKb = Math.round(content.length / 1024);
      fileInfos.push({ path, tokens, sizeKb });
    } catch {
      fileInfos.push({ path, tokens: 0, sizeKb: 0 });
    }
  }

  const criticalPaths = new Set<string>();
  const stubs = new Map<string, string>();

  for (const info of fileInfos) {
    // Rule 1: Safety-critical patterns always critical
    if (isMandatoryCritical(info.path)) {
      criticalPaths.add(info.path);
      continue;
    }

    // Rule 2: Small files always critical
    if (info.tokens <= 500) {
      criticalPaths.add(info.path);
      continue;
    }

    // Rule 3: Files matching task keywords are critical
    const pathLower = info.path.toLowerCase();
    const contentMatchesTask = taskKeywords.some((kw) => pathLower.includes(kw));
    if (contentMatchesTask) {
      criticalPaths.add(info.path);
      continue;
    }

    // Rule 4: Large files without task relevance → stub
    if (info.tokens > 2000) {
      const stubSummary = `[${info.path.split('/').pop() ?? info.path}: ${info.sizeKb} KB, ~${info.tokens} tokens — stubbed for brevity]`;
      stubs.set(info.path, stubSummary);
      continue;
    }

    // Rule 5: Default → critical
    criticalPaths.add(info.path);
  }

  return { stubs, criticalPaths };
}

// ── LLM-Based Pruning (Full Path) ────────────────────────────────────────────

export async function analyzeAndPruneContext(
  userRequest: string,
  manifestPaths: string[],
  evidence?: EvidenceBundle,
): Promise<PrunedContext> {
  // If manifest is small, don't bother pruning
  if (manifestPaths.length <= 3) {
    return { stubs: new Map(), criticalPaths: new Set(manifestPaths) };
  }

  const fileInfo = manifestPaths
    .map((p) => {
      try {
        const stats = existsSync(p)
          ? `(${Math.round(readFileSync(p, 'utf-8').length / 1024)} KB)`
          : '(missing)';
        return `${p} ${stats}`;
      } catch {
        return `${p} (error reading)`;
      }
    })
    .join('\n');

  const pruningPrompt = `
You are the Babel Context Pruner. Your goal is to identify which files in the manifest are CRITICAL for the user's request and which are SUPPLEMENTARY (can be stubbed to save tokens).

USER REQUEST:
"${userRequest}"

MANIFEST FILES:
${fileInfo}

CRITERIA:
- CRITICAL: Files likely to be edited, main logic entry points, or direct dependencies of the requested change.
- SUPPLEMENTARY: Large utility files, distant styles, boilerplate, or high-volume files not directly related to the fix.

Output the classification in JSON.
`;

  try {
    const analysis = await runWithFallback(pruningPrompt, PruningAnalysisSchema, {
      stage: 'orchestrator', // Use Scout tier
      schemaName: 'PruningAnalysisSchema',
      ...(evidence ? { evidence } : {}),
    });

    // Force safety-critical files into the critical set regardless of LLM
    // classification. The pruning model has no awareness of which files carry
    // behavioral rules, execution policies, or sandbox enforcement — a
    // misclassification here would strip the agent of safety awareness.
    const forcedCritical = analysis.supplementary_files
      .filter((f) => isMandatoryCritical(f.path))
      .map((f) => f.path);
    const cleanSupplementary = analysis.supplementary_files.filter(
      (f) => !isMandatoryCritical(f.path),
    );

    const stubs = new Map<string, string>();
    cleanSupplementary.forEach((f) => {
      stubs.set(f.path, f.summary);
    });

    return {
      stubs,
      criticalPaths: new Set([...analysis.critical_files, ...forcedCritical]),
    };
  } catch (error) {
    console.warn(
      `[pruning] ✗ Context pruning failed — using full manifest. ${error instanceof Error ? error.message : String(error)}`,
    );
    return { stubs: new Map(), criticalPaths: new Set(manifestPaths) };
  }
}
