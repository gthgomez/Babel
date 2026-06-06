import { readFileSync, existsSync } from 'node:fs';
import { runWithFallback } from '../execute.js';
import { PruningAnalysisSchema } from '../schemas/agentContracts.js';
import { EvidenceBundle } from '../evidence.js';

export interface PrunedContext {
  stubs: Map<string, string>; // Path -> Summary stub
  criticalPaths: Set<string>;
}

export function isContextPruningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['BABEL_CONTEXT_PRUNING'] === 'true';
}

export async function analyzeAndPruneContext(
  userRequest: string,
  manifestPaths: string[],
  evidence?: EvidenceBundle
): Promise<PrunedContext> {
  // If manifest is small, don't bother pruning
  if (manifestPaths.length <= 3) {
    return { stubs: new Map(), criticalPaths: new Set(manifestPaths) };
  }

  const fileInfo = manifestPaths.map(p => {
    try {
      const stats = existsSync(p) ? `(${Math.round(readFileSync(p, 'utf-8').length / 1024)} KB)` : '(missing)';
      return `${p} ${stats}`;
    } catch {
      return `${p} (error reading)`;
    }
  }).join('\n');

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
      ...(evidence ? { evidence } : {})
    });

    const stubs = new Map<string, string>();
    analysis.supplementary_files.forEach(f => {
      stubs.set(f.path, f.summary);
    });

    return {
      stubs,
      criticalPaths: new Set(analysis.critical_files)
    };

  } catch (error) {
    console.warn(`[pruning] ✗ Context pruning failed — using full manifest. ${error instanceof Error ? error.message : String(error)}`);
    return { stubs: new Map(), criticalPaths: new Set(manifestPaths) };
  }
}
