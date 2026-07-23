/**
 * C2: Workspace-aware first-move card — compact prompt scaffold for SWE tasks.
 *
 * Pure builder: takes dataset test names + problem statement and produces a
 * dense first-move card with test paths, run commands, issue symbols, and
 * explicit "do not search for test files" guidance.
 *
 * Does NOT force tools that break headless policy (no mandatory tool calls,
 * no automation that requires interactive approval).
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface FirstMoveCardInput {
  /** FAIL_TO_PASS / PASS_TO_PASS test names from the dataset. */
  testNames: string[];
  /** Issue / problem statement body text. */
  problemStatement: string;
  /** Optional repo name for context (e.g. "astropy/astropy"). */
  repo?: string;
  /** Optional hints text from the dataset instance. */
  hintsText?: string;
}

export interface FirstMoveCard {
  /** Complete markdown card text for injection into the SWE prompt. */
  text: string;
  /** Backtick-quoted symbols extracted from the problem statement. */
  symbols: string[];
  /** Deduped test file paths derived from test names. */
  testFilePaths: string[];
}

// ─── Builder ─────────────────────────────────────────────────────────────

/**
 * Build a compact first-move card for a SWE task.
 *
 * The card includes:
 * 1. Test file paths + run command (from dataset — no searching needed)
 * 2. Issue symbols extracted from backticks (for grep-guided localization)
 * 3. "Do not search for test files" guard
 * 4. Compact issue text + hints + test name list
 */
export function buildSweFirstMoveCard(input: FirstMoveCardInput): FirstMoveCard {
  const { testNames, problemStatement, repo, hintsText } = input;

  const symbols = extractBacktickSymbols(problemStatement);
  const testFilePaths = extractTestFilePaths(testNames);

  const sections: string[] = [];
  sections.push('## First-Move Card');
  sections.push('');

  // ── Repo context ────────────────────────────────────────────────────
  if (repo) {
    sections.push(`**Repo**: \`${repo}\``);
    sections.push('');
  }

  // ── Test files (known — use only for verify, NOT before mutate) ────
  if (testFilePaths.length > 0) {
    sections.push('### Test Files (known from dataset — verify AFTER patching)');
    sections.push('');
    for (const fp of testFilePaths) {
      sections.push(`- \`${fp}\``);
    }
    sections.push('');
    const firstTest = testFilePaths[0]!;
    sections.push('**Run command (use ONLY after applying your fix)**:');
    sections.push('');
    sections.push('```');
    sections.push(`python -m pytest ${firstTest} -v -x`);
    sections.push('```');
    sections.push('');
    sections.push(
      '**CRITICAL: Do NOT search for test files. Do NOT run pytest before patching.**',
      'The test file paths above are from the dataset. They are for VERIFICATION only.',
      '',
      '**Workflow**:',
      '1. Read the buggy production code (not the test file) to understand the bug',
      '2. Apply ONE targeted `str_replace` to fix the bug',
      '3. Only THEN run the pytest command above to verify your fix',
      '',
      'If the test environment is broken (missing deps, wrong version),',
      'apply the fix with `str_replace` and report the patch — do NOT try to fix the environment.',
    );
    sections.push('');
  }

  // ── Issue symbols (for grep-guided localization) ────────────────────
  if (symbols.length > 0) {
    sections.push('### Issue Symbols (grep targets from the issue)');
    sections.push('');
    for (const sym of symbols) {
      sections.push(`- \`${sym}\``);
    }
    sections.push('');
    sections.push(
      'Use `grep` to locate these symbols in the codebase. Then `read_range`',
      'only the relevant ~20-line region around each match — do NOT full-file',
      'read first. Prefer **one targeted `str_replace`** once the symbol is clear.',
    );
    sections.push('');
  }

  // ── Issue text ─────────────────────────────────────────────────────
  sections.push('### Issue');
  sections.push('');
  sections.push(problemStatement.trim());

  if (hintsText && hintsText.trim()) {
    sections.push('');
    sections.push('**Hints**:');
    sections.push(hintsText.trim());
  }

  // ── Test names (compact list) ──────────────────────────────────────
  if (testNames.length > 0) {
    sections.push('');
    sections.push('### Test Names (from dataset)');
    sections.push('');
    for (const t of testNames.slice(0, 15)) {
      sections.push(`- \`${t}\``);
    }
  }

  return {
    text: sections.join('\n'),
    symbols,
    testFilePaths,
  };
}

// ─── Interactive first-move hint ────────────────────────────────────────────

/**
 * Build a compact first-move hint for interactive chat use when a test command
 * is known (from intent plan heuristic extraction).
 *
 * Lightweight version of `buildSweFirstMoveCard` — no dataset test names
 * required. Guides the model to run tests first, inspect output, then fix.
 */
export function buildInteractiveFirstMoveHint(testCommand: string): string {
  return [
    '## First Move',
    '',
    'Localize the fix BEFORE running tests:',
    '',
    '1. Read the relevant production code to understand the bug',
    '2. Apply a minimal `str_replace` fix',
    '3. Then verify with:',
    '',
    '```',
    testCommand,
    '```',
    '',
    'Do NOT run the test command before patching. Mutate first, verify second.',
  ].join('\n');
}

// ─── Extractors ────────────────────────────────────────────────────────────

/**
 * Extract backtick-quoted symbols (identifiers, method names, class names)
 * from text. Filters out paths, URLs, bare numbers, and strings > 80 chars.
 */
export function extractBacktickSymbols(text: string): string[] {
  const matches = text.matchAll(/`([^`]+)`/g);
  const symbols: string[] = [];
  for (const m of matches) {
    const sym = m[1]!;
    // Skip paths, URLs, and non-code tokens
    if (sym.includes('/') || sym.includes('\\')) continue;
    if (sym.startsWith('http:') || sym.startsWith('https:')) continue;
    if (/^\d+(\.\d+)?$/.test(sym)) continue;
    if (sym.length > 80) continue;
    // Must contain at least one letter or underscore (identifiers)
    if (/[a-zA-Z_]/.test(sym)) {
      symbols.push(sym);
    }
  }
  return [...new Set(symbols)].slice(0, 20);
}

/**
 * Extract unique test file paths from test names.
 * "path/to/test_file.py::TestClass::test_method" → "path/to/test_file.py"
 */
export function extractTestFilePaths(testNames: string[]): string[] {
  return [
    ...new Set(
      testNames
        .map((t) => {
          const idx = t.indexOf('::');
          return idx >= 0 ? t.slice(0, idx) : t;
        })
        .filter((p): p is string => p.length > 0),
    ),
  ].slice(0, 5);
}

// ─── Metric helpers ────────────────────────────────────────────────────────

/** Mutation tools that count as "writes" for first-write detection. */
const MUTATION_TOOLS = new Set([
  'write_file',
  'str_replace',
  'apply_patch',
  'file_delete',
]);

/**
 * Count tools used before the first successful mutation.
 * Returns the count of non-mutation tools (or failed mutations) before the
 * first successful write. Returns `toolCalls.length` if no write occurred.
 *
 * Used for the `tools_before_first_write` harness metric.
 */
export function computeToolsBeforeFirstWrite(
  toolCalls: Array<{ tool: string; error?: string }>,
): number {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]!;
    if (MUTATION_TOOLS.has(tc.tool) && !tc.error) {
      return i;
    }
  }
  return toolCalls.length;
}
