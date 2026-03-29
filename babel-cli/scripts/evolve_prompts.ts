/**
 * scripts/evolve_prompts.ts — Automated Prompt Evolution Loop
 *
 * Scans all historical execution runs under `Babel/runs/`, finds QA REJECT
 * verdicts, aggregates failure patterns by Domain Architect file, and writes
 * structured evolution proposals to `Babel/04_Meta_Tools/proposed_evolutions.json`
 * for human review.
 *
 * HUMAN-IN-THE-LOOP: This script NEVER modifies files under 02_Domain_Architects/.
 * It only writes to a staging file. A human must review and apply approved proposals.
 *
 * Run: tsx scripts/evolve_prompts.ts
 *
 * Architecture rules observed:
 *   - No external dependencies — uses only node:fs, node:path, and the project's
 *     existing zod schemas from src/schemas/agentContracts.ts.
 *   - Windows-safe: all paths built with path.join / path.resolve.
 *   - Read-only on the runs/ directory; mkdirSync used only for 04_Meta_Tools/.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath }                    from 'node:url';
import { z }                                from 'zod';

// tsx resolves .js imports to their .ts source at runtime — this is intentional.
import {
  OrchestratorManifestSchema,
  QaVerdictRejectSchema,
  QaVerdictPassSchema,
} from '../src/schemas/agentContracts.js';

// ─── Path resolution ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/** babel-cli/scripts/ → babel-cli/ → Babel/ */
const BABEL_ROOT  = resolve(__dirname, '../..');
const RUNS_DIR    = join(BABEL_ROOT, 'runs');
const OUTPUT_DIR  = join(BABEL_ROOT, '04_Meta_Tools');
const OUTPUT_FILE = join(OUTPUT_DIR, 'proposed_evolutions.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface RejectionOccurrence {
  run_dir:               string;   // e.g. "20260301_005227_build-a-simple..."
  verdict_file:          string;   // e.g. "03_qa_verdict_v2.json"
  verdict_attempt:       number;   // e.g. 2
  condition:             string;   // Verbatim QA condition string
  confidence:            number;   // 1–5
  proposed_fix_strategy: string | null;
}

interface FailurePattern {
  tag:         string;                // e.g. "NAMIT-N"
  count:       number;
  occurrences: RejectionOccurrence[];
}

interface ArchitectProposal {
  target_file:           string;   // e.g. "Clean_SWE_Backend-v7.md" or another cataloged domain architect file
  target_file_full_path: string;   // Absolute Windows path from manifest
  total_rejection_count: number;
  failure_patterns:      FailurePattern[];
  evolution_prompt:      string;   // Copy/paste this into an LLM to evolve the target file
}

interface EvolutionReport {
  generated_at:          string;
  runs_dir:              string;
  runs_scanned:          number;
  reject_verdicts_found: number;
  architects_affected:   number;
  proposals:             ArchitectProposal[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns paths to all immediate subdirectories of `dir`. */
function getSubdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(dir, e.name));
}

/** Parses a JSON file; returns null on any read/parse error. */
function safeReadJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Returns all QA verdict filenames in a run directory, sorted by attempt number.
 * Matches the EvidenceBundle naming convention: `03_qa_verdict_v{N}.json`.
 */
function getQaVerdictFiles(runDir: string): { filename: string; attempt: number }[] {
  const pattern = /^03_qa_verdict_v(\d+)\.json$/;
  return readdirSync(runDir)
    .map(name => {
      const match = pattern.exec(name);
      return match ? { filename: name, attempt: parseInt(match[1]!, 10) } : null;
    })
    .filter((x): x is { filename: string; attempt: number } => x !== null)
    .sort((a, b) => a.attempt - b.attempt);
}

/**
 * Filters the manifest's `prompt_manifest` string array to paths that
 * fall under the 02_Domain_Architects directory.
 * Handles both forward-slash and backslash separators.
 */
function extractArchitectPaths(
  manifest: z.infer<typeof OrchestratorManifestSchema>,
): string[] {
  return manifest.prompt_manifest.filter(p =>
    p.replace(/\\/g, '/').includes('02_Domain_Architects'),
  );
}

/**
 * Builds an LLM-ready prompt the user can copy/paste to request a permanent
 * structural update to the target markdown file selected from historical run manifests.
 */
function buildEvolutionPrompt(
  targetFile:      string,
  patterns:        FailurePattern[],
  totalRejections: number,
): string {
  const tagSummary = patterns
    .map(p => {
      const sample = p.occurrences[0]?.condition ?? '(no condition recorded)';
      const extra  = p.count > 1 ? ` (plus ${p.count - 1} similar occurrence(s))` : '';
      return `  - [${p.tag}] × ${p.count}: "${sample}"${extra}`;
    })
    .join('\n');

  // Unique, non-null fix strategies from the QA reviewer
  const fixHints = [
    ...new Set(
      patterns
        .flatMap(p => p.occurrences.map(o => o.proposed_fix_strategy))
        .filter((s): s is string => s !== null),
    ),
  ].map(s => `  - ${s}`).join('\n');

  const lines = [
    `You are a Prompt Engineer maintaining the Babel Multi-Agent OS prompt library.`,
    ``,
    `The prompt file "${targetFile}" has accumulated ${totalRejections} QA`,
    `REJECT verdict(s) across multiple pipeline runs. The QA Adversarial Reviewer`,
    `consistently raised the following failure patterns:`,
    ``,
    tagSummary,
  ];

  if (fixHints) {
    lines.push(``, `QA-suggested fix directions (optional context):`, fixHints);
  }

  lines.push(
    ``,
    `YOUR TASK:`,
    `Propose a new strict rule or clarification to APPEND to the file "${targetFile}"`,
    `that would prevent these failure patterns from recurring. The rule must:`,
    `  1. Be written in the imperative voice (e.g. "The SWE Agent MUST ...").`,
    `  2. Address the root pattern, not just the surface symptom.`,
    `  3. Be a self-contained section the SWE Agent can act on without extra context.`,
    `  4. NOT alter any existing rules — append only.`,
    ``,
    `Output ONLY the proposed markdown block. No preamble, no explanation.`,
  );

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('[evolve] ─────────────────────────────────────────────────────');
  console.log('[evolve]  Babel Prompt Evolution Loop');
  console.log('[evolve] ─────────────────────────────────────────────────────');
  console.log(`[evolve]  Runs dir:  ${RUNS_DIR}`);
  console.log(`[evolve]  Output:    ${OUTPUT_FILE}`);
  console.log('[evolve] ─────────────────────────────────────────────────────');
  console.log('');

  // ── Step 1: Scan run directories ──────────────────────────────────────────
  const runDirs = getSubdirectories(RUNS_DIR);
  console.log(`[evolve] Discovered ${runDirs.length} run director${runDirs.length === 1 ? 'y' : 'ies'}.`);
  console.log('');

  // Aggregation: architectFullPath → tag → occurrences[]
  const aggregation = new Map<string, Map<string, RejectionOccurrence[]>>();

  let runsScanned     = 0;
  let rejectCount     = 0;

  for (const runDir of runDirs) {
    const runSlug      = basename(runDir);
    const manifestPath = join(runDir, '01_manifest.json');

    // ── Step 2a: Load and validate manifest ───────────────────────────────
    if (!existsSync(manifestPath)) {
      console.log(`  [skip]  ${runSlug} — no 01_manifest.json`);
      continue;
    }

    const rawManifest    = safeReadJson(manifestPath);
    const manifestResult = OrchestratorManifestSchema.safeParse(rawManifest);
    if (!manifestResult.success) {
      console.log(`  [skip]  ${runSlug} — manifest did not validate (${manifestResult.error.issues[0]?.message ?? 'unknown'})`);
      continue;
    }

    const manifest       = manifestResult.data;
    const architectPaths = extractArchitectPaths(manifest);

    // ── Step 2b: Locate QA verdict files ──────────────────────────────────
    const verdictFiles = getQaVerdictFiles(runDir);
    if (verdictFiles.length === 0) {
      console.log(`  [skip]  ${runSlug} — no QA verdict files`);
      continue;
    }

    runsScanned++;
    console.log(
      `  [scan]  ${runSlug}` +
      ` (${verdictFiles.length} verdict(s), ${architectPaths.length} architect path(s))`,
    );

    // ── Step 2c: Extract rejections ────────────────────────────────────────
    for (const { filename, attempt } of verdictFiles) {
      const verdictPath = join(runDir, filename);
      const rawVerdict  = safeReadJson(verdictPath);

      // Quick PASS check — skip without noise
      if (QaVerdictPassSchema.safeParse(rawVerdict).success) {
        console.log(`          ${filename} → PASS`);
        continue;
      }

      const rejectResult = QaVerdictRejectSchema.safeParse(rawVerdict);
      if (!rejectResult.success) {
        console.log(`          ${filename} → unrecognised shape, skipping`);
        continue;
      }

      const verdict     = rejectResult.data;
      const fixStrategy = verdict.proposed_fix_strategy ?? null;

      console.log(
        `          ${filename} → REJECT (${verdict.failure_count} failure(s)` +
        (fixStrategy ? ', has fix hint' : '') + ')',
      );

      rejectCount++;

      // ── Step 3: Aggregate by architect file ─────────────────────────────
      for (const failure of verdict.failures) {
        // If no Domain Architect file is in the manifest, attribute to 'unknown'
        const targets = architectPaths.length > 0 ? architectPaths : ['(unknown)'];

        for (const archPath of targets) {
          if (!aggregation.has(archPath)) {
            aggregation.set(archPath, new Map());
          }
          const tagMap = aggregation.get(archPath)!;
          if (!tagMap.has(failure.tag)) {
            tagMap.set(failure.tag, []);
          }
          tagMap.get(failure.tag)!.push({
            run_dir:               runSlug,
            verdict_file:          filename,
            verdict_attempt:       attempt,
            condition:             failure.condition,
            confidence:            failure.confidence,
            proposed_fix_strategy: fixStrategy,
          });
        }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(`[evolve] ─────────────────────────────────────────────────────`);
  console.log(`[evolve]  Runs with verdicts : ${runsScanned}`);
  console.log(`[evolve]  REJECT verdicts    : ${rejectCount}`);
  console.log(`[evolve]  Architect files    : ${aggregation.size}`);
  console.log(`[evolve] ─────────────────────────────────────────────────────`);
  console.log('');

  // ── Step 4: Build proposals ────────────────────────────────────────────────
  const proposals: ArchitectProposal[] = [];

  for (const [archPath, tagMap] of aggregation.entries()) {
    const fileName = basename(archPath);
    const patterns: FailurePattern[] = [];
    let totalRejections = 0;

    for (const [tag, occurrences] of tagMap.entries()) {
      patterns.push({ tag, count: occurrences.length, occurrences });
      totalRejections += occurrences.length;
    }

    // Most-frequent failures first
    patterns.sort((a, b) => b.count - a.count);

    proposals.push({
      target_file:           fileName,
      target_file_full_path: archPath,
      total_rejection_count: totalRejections,
      failure_patterns:      patterns,
      evolution_prompt:      buildEvolutionPrompt(fileName, patterns, totalRejections),
    });

    console.log(
      `  [proposal] ${fileName}` +
      ` — ${totalRejections} rejection(s), ${patterns.length} tag(s):` +
      ` ${patterns.map(p => `[${p.tag}]×${p.count}`).join(', ')}`,
    );
  }

  // Most impactful proposals first
  proposals.sort((a, b) => b.total_rejection_count - a.total_rejection_count);

  // ── Step 5: Write staging file ─────────────────────────────────────────────
  const report: EvolutionReport = {
    generated_at:          new Date().toISOString(),
    runs_dir:              RUNS_DIR,
    runs_scanned:          runsScanned,
    reject_verdicts_found: rejectCount,
    architects_affected:   proposals.length,
    proposals,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf-8');

  console.log('');
  console.log(`[evolve] ✓ Proposals written to:`);
  console.log(`[evolve]   ${OUTPUT_FILE}`);
  console.log('');
  console.log(`[evolve] NEXT STEPS (human review required):`);
  console.log(`[evolve]   1. Open proposed_evolutions.json`);
  console.log(`[evolve]   2. For each proposal, copy evolution_prompt into an LLM`);
  console.log(`[evolve]   3. Review the proposed markdown rule`);
  console.log(`[evolve]   4. Manually append approved rules to 02_Domain_Architects/<file>`);
  console.log(`[evolve]   5. Re-run the pipeline to verify the new rule resolves rejections`);
}

main();
