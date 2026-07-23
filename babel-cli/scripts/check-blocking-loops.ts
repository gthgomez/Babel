#!/usr/bin/env npx tsx
/**
 * check-blocking-loops.ts — Heuristic scanner for synchronous loops that may
 * block the Node.js event loop.
 *
 * Scans `for…of` and `while` loops in src/services/*.ts for I/O or database
 * calls without a corresponding `setImmediate` / `setTimeout` yield point.
 *
 * This script is intentionally noisy — false positives are expected and should
 * be triaged by a human reviewer. A clean exit (code 0) means no patterns were
 * found; exit code 1 means suspicious loops were detected.
 *
 * Usage:
 *   npx tsx scripts/check-blocking-loops.ts
 *   npx tsx scripts/check-blocking-loops.ts --json   (machine-readable output)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const SERVICES_DIR = join(import.meta.dirname, '..', 'src', 'services');
const JSON_MODE = process.argv.includes('--json');

// ── Patterns that indicate I/O or DB work inside a loop ──────────────────
const IO_CALLS = /\b(readFileSync|writeFileSync|existsSync|statSync|readdirSync|\.run\(|\.exec\(|\.get\(|\.all\(|\.prepare\(|spawn|execSync|readFile|writeFile|appendFile)\b/;

// ── Patterns that indicate the loop already yields ───────────────────────
const YIELD_PATTERNS = /\b(setImmediate|setTimeout|await\s+new\s+Promise)\b/;

// ── Loop detection patterns ──────────────────────────────────────────────
const FOR_OF = /^\s*for\s*\(/;
const WHILE = /^\s*while\s*\(/;

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(filePath: string): Finding[] {
  const findings: Finding[] = [];
  const lines = readFileSync(filePath, 'utf-8').split('\n');

  let inLoop = false;
  let loopStart = 0;
  let loopBraceDepth = 0;
  let loopHasIO = false;
  let loopHasYield = false;
  let braceDepth = 0;

  // Simple brace-counting heuristic — not a full parser. Sufficient for
  // catching the common case: `for (const x of arr) { ... syncIO ... }`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (!inLoop) {
      if (FOR_OF.test(line) || WHILE.test(line)) {
        inLoop = true;
        loopStart = i + 1; // 1-based line number
        loopBraceDepth = braceDepth;
        loopHasIO = false;
        loopHasYield = false;
      }
    }

    // Count braces on this line
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    if (inLoop) {
      if (IO_CALLS.test(line)) loopHasIO = true;
      if (YIELD_PATTERNS.test(line)) loopHasYield = true;

      // Loop body ends when brace depth returns to pre-loop level
      if (braceDepth <= loopBraceDepth) {
        if (loopHasIO && !loopHasYield) {
          findings.push({
            file: filePath.replace(SERVICES_DIR + '/', ''),
            line: loopStart,
            snippet: (lines[loopStart - 1] ?? '').trim().slice(0, 100),
          });
        }
        inLoop = false;
      }
    }
  }

  return findings;
}

// ── Main ─────────────────────────────────────────────────────────────────
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.ts' && !entry.name.includes('.test.')) {
      files.push(full);
    }
  }
  return files.sort();
}

const allFindings: Finding[] = [];
for (const file of collectTsFiles(SERVICES_DIR)) {
  allFindings.push(...scanFile(file));
}

if (JSON_MODE) {
  console.log(JSON.stringify(allFindings, null, 2));
} else if (allFindings.length > 0) {
  console.log(`${allFindings.length} potentially blocking loop(s) found:\n`);
  for (const f of allFindings) {
    console.log(`  ${f.file}:${f.line}  ${f.snippet}`);
  }
  console.log(`\nReview each loop. If it iterates over an unbounded collection with I/O calls, add setImmediate yielding.`);
  process.exit(1);
} else {
  console.log('No blocking loops detected in src/services/.');
}
