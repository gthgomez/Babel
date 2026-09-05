#!/usr/bin/env node
// Campaign-status consistency guard (static, offline).
//
// Validates docs/campaigns/DAILY_DRIVER_CAMPAIGN_STATUS.md against the
// invariants that campaign drift has historically violated:
//   1. a phase marked COMPLETE must cite its PR (or an explicit baseline
//      marker) and a merge/commit SHA;
//   2. no phase row may mix state markers;
//   3. `last_verified` must not predate any verification-log row;
//   4. the verification log must be chronologically non-decreasing;
//   5. historical superlatives about repository history are not allowed in
//      phase-table rows (first/only/never before) — verified claims belong
//      in prose with evidence.
//
// Known scope limits (deliberate, for a 7-row terse table): the marker-mixing
// check covers only COMPLETE+IN PROGRESS, and the superlative regex matches
// superlative-then-PR-reference ordering only.
//
// Exit 0 = consistent; exit 1 = violations (listed).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = join(repoRoot, 'docs', 'campaigns', 'DAILY_DRIVER_CAMPAIGN_STATUS.md');
const text = readFileSync(docPath, 'utf-8');
const violations = [];

// ── 1+2. Phase tracker rows ─────────────────────────────────────────────────
const trackerMatch = text.match(/##\s+Phase Tracker[\s\S]*?(?=\n##\s)/);
if (!trackerMatch) {
  violations.push('phase-tracker: "## Phase Tracker" section not found');
} else {
  const rows = trackerMatch[0].split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
  if (rows.length === 0) violations.push('phase-tracker: no phase rows found');
  for (const row of rows) {
    const phase = row.split('|')[1]?.trim() ?? '?';
    const isComplete = /\*\*COMPLETE\*\*/.test(row);
    const inProgress = /IN PROGRESS/i.test(row);
    if (isComplete && inProgress) {
      violations.push(`phase ${phase}: row contains both COMPLETE and IN PROGRESS`);
    }
    if (isComplete) {
      const isBaselineMarker = /\bbaseline\b/i.test(row);
      const citesPr = /#?\bPR-\d+\b|pull\/\d+|#\d+\)/.test(row) || isBaselineMarker;
      const citesSha = /[0-9a-f]{7,40}/i.test(row) || isBaselineMarker;
      if (!citesPr) {
        violations.push(`phase ${phase}: COMPLETE without a PR reference (or explicit baseline marker)`);
      }
      if (!citesSha) {
        violations.push(`phase ${phase}: COMPLETE without a merge/commit SHA (or explicit baseline marker)`);
      }
    }
    if (/\b(first|only|never before)\b[^|]*#\d+/i.test(row)) {
      violations.push(`phase ${phase}: historical superlative with a PR reference — verify against GitHub and state the evidence in prose instead`);
    }
  }
}

// ── 3+4. last_verified vs verification log ──────────────────────────────────
const lastVerifiedMatch = text.match(/last_verified:\s*(\d{4}-\d{2}-\d{2})/);
if (!lastVerifiedMatch) {
  violations.push('frontmatter: last_verified date missing');
}
const logMatch = text.match(/##\s+Verification Log[\s\S]*?(?=\n###\s|\n##\s)/);
if (!logMatch) {
  violations.push('verification-log: "## Verification Log" section not found');
} else {
  const dates = [...logMatch[0].matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map((m) => m[1]);
  if (dates.length === 0) violations.push('verification-log: no dated rows found');
  if (lastVerifiedMatch && dates.length > 0) {
    const stale = dates.filter((d) => d > lastVerifiedMatch[1]);
    if (stale.length > 0) {
      violations.push(`frontmatter: last_verified (${lastVerifiedMatch[1]}) predates verification-log row(s) ${[...new Set(stale)].join(', ')}`);
    }
  }
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < dates[i - 1]) {
      violations.push(`verification-log: row ${i + 1} (${dates[i]}) is older than row ${i} (${dates[i - 1]})`);
      break;
    }
  }
}

if (violations.length > 0) {
  console.error('campaign-status consistency FAILED:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`campaign-status consistency passed (${docPath}).`);
