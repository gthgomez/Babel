/**
 * cmdTokenizer.ts — Windows cmd.exe context-aware tokenizer for shell
 * metacharacter detection.
 *
 * The existing SHELL_OPERATOR_RE regex in sandbox.ts is context-unaware:
 * it treats all operator characters as equally dangerous regardless of
 * context (inside quotes, escaped with ^, or part of a valid %VAR%
 * expansion). This module provides a second-pass tokenizer that reduces
 * false positives while maintaining the same security boundary.
 *
 * Design:
 *   - The regex pre-check in sandbox.ts remains as a fast first pass.
 *   - If the regex matches, this tokenizer does a context-aware second pass.
 *   - If the tokenizer determines the match is in a safe context, the
 *     command is allowed through.
 *   - If the tokenizer confirms a dangerous context, the command is rejected.
 *
 * cmd.exe parsing phases (simplified):
 *   1. Tokenization — split on unquoted whitespace
 *   2. Variable expansion — %VAR% is expanded BEFORE command parsing
 *   3. Redirection — >, >>, <, | are processed
 *   4. Command chaining — &, &&, || connect commands
 *   5. Caret escaping — ^ escapes the next character
 *
 * Dangerous in ALL contexts: | (pipe), & (command separator outside &&/||)
 * Dangerous outside quotes: >, <, (, ), %, ^
 * Safe inside quotes: >, <, |, &, (, ), %, ^ (except %VAR% expansion still happens!)
 * Safe when caret-escaped: any single character after ^
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenizerResult {
  /** Whether the command is safe to execute (no dangerous operators in unsafe context). */
  safe: boolean;
  /**
   * Whether the tokenizer fully analyzed all regex-matched characters.
   * If false, characters matched by the regex were not analyzed and the
   * regex-based rejection should stand (defense-in-depth).
   */
  fullyAnalyzed: boolean;
  /** If unsafe, the reason for rejection. */
  reason?: string;
  /** If unsafe, the operator character that triggered rejection. */
  operator?: string;
  /** If unsafe, the context position where it was found. */
  context?: 'unquoted' | 'pipe' | 'redirect' | 'command_chain' | 'expansion';
}

// ── Character classification ─────────────────────────────────────────────────

/** Characters that are ALWAYS dangerous on cmd.exe, even inside quotes. */
const ALWAYS_DANGEROUS = new Set([
  '|', // pipe — always dangerous, even in quotes
]);

/**
 * Characters dangerous outside double-quoted strings on cmd.exe.
 * ';' is moved here from ALWAYS_DANGEROUS — it is safe inside Python -c "..."
 * strings, which is a common verifier pattern. Outside quotes, ';' is still
 * a command separator on cmd.exe and will be rejected.
 */

/**
 * Characters dangerous outside double-quoted strings on cmd.exe.
 * Note: % is dangerous because cmd.exe expands %VAR% before command processing.
 */
const DANGEROUS_OUTSIDE_QUOTES = new Set([
  '&', // command separator (&& is handled separately by cd-prefix logic)
  ';', // command separator on cmd.exe (safe inside quotes for python -c "...")
  '>', // redirect stdout
  '<', // redirect stdin
  '(', // subshell/grouping (cmd.exe supports limited grouping)
  ')',
  '%', // variable expansion
]);

/** Characters safely allowed when caret-escaped (^X). */
const SAFE_CARET_ESCAPED = new Set(['&', '|', '>', '<', '(', ')', '%', '^', '"']);

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Context-aware cmd.exe tokenizer.
 *
 * Walks the command string character by character, tracking:
 *   - Whether we're inside double quotes
 *   - Whether the previous character was a caret escape (^)
 *   - Whether we're inside a %VAR% expansion
 *
 * Returns a TokenizerResult indicating whether the command is safe.
 */
export function tokenizeCmdCommand(command: string): TokenizerResult {
  // ── cd / chdir / pushd prefix with && —──────────────────────────────────
  // Windows agents need "cd <path> && <cmd>" to run commands in the project
  // root because cmd.exe has no single-command directory-change primitive.
  // Allow && when the left side is a safe directory-change command and the
  // right side passes independent validation (recursive check).
  const cdPrefixMatch = command.match(
    /^\s*(cd|chdir|pushd)\s+(.+?)\s*&&\s*(.+)$/is,
  );
  if (cdPrefixMatch) {
    const dirChangeCmd = cdPrefixMatch[1]!.toLowerCase();
    const dirPath = cdPrefixMatch[2]!.trim();
    const rightCmd = cdPrefixMatch[3]!;
    // cd/chdir/pushd with a path and a follow-up command — recurse into
    // the right side. The directory change itself is safe.
    if (
      (dirChangeCmd === 'cd' || dirChangeCmd === 'chdir' || dirChangeCmd === 'pushd') &&
      dirPath.length > 0
    ) {
      return tokenizeCmdCommand(rightCmd);
    }
  }

  let inDoubleQuotes = false;
  let prevWasCaret = false;
  let inVarExpansion = false; // inside %VAR%
  let expansionStart = -1;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    // ── Unhandled characters: if we encounter a character matched by the
    // regex but NOT handled by our tokenizer, mark as not fully analyzed
    // so the regex pre-check rejection stands.
    // Backslash is NOT included — it's a path separator on Windows and an
    // escape inside double quotes (handled below).
    if ('`$\r\n'.includes(ch) && !inDoubleQuotes && !prevWasCaret) {
      return {
        safe: false,
        fullyAnalyzed: false,
        reason: `Unhandled operator '${ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch}' detected — deferring to regex pre-check`,
        operator: ch,
        context: 'unquoted',
      };
    }

    // ── Backslash handling ──────────────────────────────────────────────────
    // Outside quotes: backslash is a Windows path separator — safe.
    // Inside double quotes: backslash escapes the next character (like ^ outside).
    if (ch === '\\' && inDoubleQuotes) {
      // Skip the next character — it's escaped by backslash inside quotes
      i++; // skip the escaped character
      continue;
    }

    // ── Caret escape handling ──────────────────────────────────────────────
    if (ch === '^' && !prevWasCaret && !inVarExpansion) {
      prevWasCaret = true;
      continue;
    }

    if (prevWasCaret) {
      // ^ escapes the next character — it becomes a literal
      prevWasCaret = false;
      continue;
    }

    // ── Variable expansion tracking ─────────────────────────────────────────
    if (ch === '%' && !inVarExpansion) {
      inVarExpansion = true;
      expansionStart = i;
      continue;
    }
    if (ch === '%' && inVarExpansion) {
      if (i === expansionStart + 1) {
        // %% → literal %, not an expansion
        inVarExpansion = false;
        continue;
      }
      return {
        safe: false,
        fullyAnalyzed: true,
        reason: `Variable expansion %...% detected at position ${expansionStart}-${i}`,
        operator: '%',
        context: 'expansion',
      };
    }

    // ── Double-quote tracking ───────────────────────────────────────────────
    if (ch === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }

    // ── Always-dangerous characters ─────────────────────────────────────────
    if (ALWAYS_DANGEROUS.has(ch)) {
      return {
        safe: false,
        fullyAnalyzed: true,
        reason: `Operator '${ch}' detected — always dangerous on cmd.exe`,
        operator: ch,
        context: ch === '|' ? 'pipe' : 'command_chain',
      };
    }

    // ── Outside-quotes dangerous characters ─────────────────────────────────
    if (!inDoubleQuotes && DANGEROUS_OUTSIDE_QUOTES.has(ch)) {
      if (ch === '&') {
        return {
          safe: false,
          fullyAnalyzed: true,
          reason: `Command separator '&' detected outside quotes`,
          operator: '&',
          context: 'command_chain',
        };
      }
      if (ch === '>') {
        // Allow the safe `2>&1` pattern (redirect stderr to stdout) which
        // writes no files — it is a file-descriptor merge, not a file redirect.
        // This is commonly used in verifier/test commands to capture stderr.
        if (
          i > 0 &&
          command[i - 1] === '2' &&
          i + 2 < command.length &&
          command[i + 1] === '&' &&
          command[i + 2] === '1'
        ) {
          // Consume `>&1` portion of `2>&1` and continue scanning
          i += 2;
          continue;
        }
        return {
          safe: false,
          fullyAnalyzed: true,
          reason: `Redirect '>' detected outside quotes`,
          operator: '>',
          context: 'redirect',
        };
      }
      if (ch === '<') {
        return {
          safe: false,
          fullyAnalyzed: true,
          reason: `Redirect '<' detected outside quotes`,
          operator: '<',
          context: 'redirect',
        };
      }
      return {
        safe: false,
        fullyAnalyzed: true,
        reason: `Shell operator '${ch}' detected outside quotes at position ${i}`,
        operator: ch,
        context: 'unquoted',
      };
    }
  }

  // Full scan complete — all characters analyzed
  return { safe: true, fullyAnalyzed: true };
}

// ── Integration helper ───────────────────────────────────────────────────────

/**
 * Second-pass context-aware check for shell operators.
 *
 * Call this AFTER the fast regex pre-check (SHELL_OPERATOR_RE) passes.
 * If the regex found a match, use this to determine if it's in a safe context.
 *
 * @param command  - The full shell command string
 * @param platform - The current platform
 * @returns null if the command is safe, or a rejection reason string
 */
/**
 * Result from the context-aware operator check.
 * - `explicitlySafe`: the tokenizer fully analyzed the command and found all
 *   regex-matched characters are in safe contexts (quoted or caret-escaped).
 *   The regex rejection should be OVERRIDDEN.
 * - `confirmedDangerous`: the tokenizer confirmed dangerous operators.
 *   The regex rejection should STAND.
 * - `notAnalyzed`: the tokenizer could not analyze some characters.
 *   The regex rejection should STAND (defense-in-depth).
 */
export type ContextCheckOutcome =
  | { verdict: 'explicitly_safe' }
  | { verdict: 'confirmed_dangerous'; reason: string }
  | { verdict: 'not_analyzed'; reason: string };

export function contextAwareOperatorCheck(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ContextCheckOutcome {
  if (platform !== 'win32') {
    return { verdict: 'not_analyzed', reason: 'POSIX — relying on regex pre-check' };
  }

  const result = tokenizeCmdCommand(command);
  if (result.safe && result.fullyAnalyzed) {
    return { verdict: 'explicitly_safe' };
  }
  if (!result.fullyAnalyzed) {
    return {
      verdict: 'not_analyzed',
      reason: result.reason ?? 'Unhandled characters — deferring to regex',
    };
  }
  return {
    verdict: 'confirmed_dangerous',
    reason: result.reason ?? 'Unsafe shell operator detected',
  };
}
