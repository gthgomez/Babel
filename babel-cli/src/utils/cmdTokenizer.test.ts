/**
 * cmdTokenizer.test.ts — Tests for cmd.exe context-aware shell operator detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeCmdCommand,
  contextAwareOperatorCheck,
  type ContextCheckOutcome,
} from './cmdTokenizer.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Safe commands (should pass)
// ═══════════════════════════════════════════════════════════════════════════════

describe('safe commands', () => {
  it('allows simple command: npm test', () => {
    assert.equal(tokenizeCmdCommand('npm test').safe, true);
  });

  it('allows command with arguments: node build.js', () => {
    assert.equal(tokenizeCmdCommand('node build.js').safe, true);
  });

  it('allows command with path: git status', () => {
    assert.equal(tokenizeCmdCommand('git status').safe, true);
  });

  it('allows quoted arguments: npm run test -- --coverage', () => {
    assert.equal(tokenizeCmdCommand('npm run test -- --coverage').safe, true);
  });

  it('allows Windows path arguments: type src\\main.ts', () => {
    assert.equal(tokenizeCmdCommand('type src\\main.ts').safe, true);
  });

  it('allows python script execution: python test.py', () => {
    assert.equal(tokenizeCmdCommand('python test.py').safe, true);
  });

  it('allows caret-escaped ampersand: echo hello ^& goodbye', () => {
    const result = tokenizeCmdCommand('echo hello ^& goodbye');
    assert.equal(result.safe, true);
  });

  it('allows caret-escaped pipe: echo hello ^| goodbye', () => {
    const result = tokenizeCmdCommand('echo hello ^| goodbye');
    assert.equal(result.safe, true);
  });

  it('allows caret-escaped redirect: echo hello ^> file.txt', () => {
    const result = tokenizeCmdCommand('echo hello ^> file.txt');
    assert.equal(result.safe, true);
  });

  it('allows double-caret literal: echo ^^', () => {
    const result = tokenizeCmdCommand('echo ^^');
    assert.equal(result.safe, true);
  });

  it('allows operators inside double quotes: echo "hello & goodbye"', () => {
    const result = tokenizeCmdCommand('echo "hello & goodbye"');
    assert.equal(result.safe, true);
  });

  it('allows redirect inside quotes: echo "a > b"', () => {
    const result = tokenizeCmdCommand('echo "a > b"');
    assert.equal(result.safe, true);
  });

  it('allows percent inside quotes: echo "100% complete"', () => {
    const result = tokenizeCmdCommand('echo "100% complete"');
    assert.equal(result.safe, true);
  });

  it('allows single percent literal: echo 50%', () => {
    // Single % is literal on cmd.exe (no closing %)
    const result = tokenizeCmdCommand('echo 50%');
    assert.equal(result.safe, true);
  });

  it('allows stderr-to-stdout redirect: 2>&1', () => {
    const result = tokenizeCmdCommand('python -c "import sys; print(sys.version)" 2>&1');
    assert.equal(result.safe, true);
  });

  it('allows 2>&1 with cd prefix', () => {
    const result = tokenizeCmdCommand(
      'cd C:\\workspace && python -c "print(1/2)" 2>&1',
    );
    assert.equal(result.safe, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Dangerous commands (should be rejected)
// ═══════════════════════════════════════════════════════════════════════════════

describe('dangerous commands', () => {
  it('rejects pipe: npm test | cat', () => {
    const result = tokenizeCmdCommand('npm test | cat');
    assert.equal(result.safe, false);
    assert.equal(result.operator, '|');
  });

  it('rejects command chaining: npm test & echo pwned', () => {
    const result = tokenizeCmdCommand('npm test & echo pwned');
    assert.equal(result.safe, false);
    assert.equal(result.operator, '&');
  });

  it('rejects conditional chain: npm test && echo pwned', () => {
    const result = tokenizeCmdCommand('npm test && echo pwned');
    assert.equal(result.safe, false);
  });

  it('rejects redirect: npm test > output.txt', () => {
    const result = tokenizeCmdCommand('npm test > output.txt');
    assert.equal(result.safe, false);
    assert.equal(result.operator, '>');
  });

  it('rejects stderr-to-file redirect: python -c "x" 2>error.log', () => {
    // 2>file.txt redirects stderr to a file — dangerous
    const result = tokenizeCmdCommand('python -c "x" 2>error.log');
    assert.equal(result.safe, false);
    assert.equal(result.operator, '>');
  });

  it('rejects input redirect: npm test < input.txt', () => {
    const result = tokenizeCmdCommand('npm test < input.txt');
    assert.equal(result.safe, false);
    assert.equal(result.operator, '<');
  });

  it('rejects variable expansion: echo %USERPROFILE%', () => {
    const result = tokenizeCmdCommand('echo %USERPROFILE%');
    assert.equal(result.safe, false);
    assert.equal(result.operator, '%');
  });

  it('rejects unquoted ampersand: npm test & whoami', () => {
    const result = tokenizeCmdCommand('npm test & whoami');
    assert.equal(result.safe, false);
  });

  it('rejects pipe with spaces: npm test    |    cat', () => {
    const result = tokenizeCmdCommand('npm test    |    cat');
    assert.equal(result.safe, false);
  });

  it('rejects semicolon command separator: npm test; echo pwned', () => {
    const result = tokenizeCmdCommand('npm test; echo pwned');
    assert.equal(result.safe, false);
    assert.equal(result.operator, ';');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('handles empty command', () => {
    assert.equal(tokenizeCmdCommand('').safe, true);
  });

  it('handles command with only whitespace', () => {
    assert.equal(tokenizeCmdCommand('   ').safe, true);
  });

  it('handles very long command', () => {
    const long = 'npm test -- ' + 'x '.repeat(1000);
    assert.equal(tokenizeCmdCommand(long).safe, true);
  });

  it('handles percent as literal at end of string', () => {
    // Unclosed % at end of string is literal
    assert.equal(tokenizeCmdCommand('echo 100%').safe, true);
  });

  it('rejects %% as variable expansion attempt', () => {
    // %%VAR%% would be an expansion — but the tokenizer handles it
    const result = tokenizeCmdCommand('echo %USERPROFILE%');
    assert.equal(result.safe, false);
  });

  it('handles caret at end of string as literal', () => {
    // ^ at end of line is a line continuation in cmd.exe, but as a literal
    // in our context it's just a trailing character
    const result = tokenizeCmdCommand('echo hello ^');
    assert.equal(result.safe, true);
  });

  it('allows empty quoted string: echo ""', () => {
    assert.equal(tokenizeCmdCommand('echo ""').safe, true);
  });

  it('allows nested-like quotes: echo "hello \\"world\\""', () => {
    // Backslash-escaped quotes inside double quotes — still inside quotes
    const result = tokenizeCmdCommand('echo "hello \\"world\\""');
    assert.equal(result.safe, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Platform-specific contextAwareOperatorCheck
// ═══════════════════════════════════════════════════════════════════════════════

describe('contextAwareOperatorCheck', () => {
  it('returns explicitly_safe for safe commands on win32', () => {
    assert.equal(contextAwareOperatorCheck('npm test', 'win32').verdict, 'explicitly_safe');
  });

  it('returns confirmed_dangerous for dangerous commands on win32', () => {
    const result = contextAwareOperatorCheck('npm test | cat', 'win32');
    assert.equal(result.verdict, 'confirmed_dangerous');
    assert.ok(result.reason!.includes('pipe') || result.reason!.includes('|'));
  });

  it('returns not_analyzed on POSIX (relies on regex pre-check)', () => {
    assert.equal(contextAwareOperatorCheck('npm test | cat', 'linux').verdict, 'not_analyzed');
    assert.equal(
      contextAwareOperatorCheck('npm test && echo hi', 'darwin').verdict,
      'not_analyzed',
    );
  });

  it('returns explicitly_safe for caret-escaped operators', () => {
    assert.equal(
      contextAwareOperatorCheck('echo hello ^& goodbye', 'win32').verdict,
      'explicitly_safe',
    );
    assert.equal(
      contextAwareOperatorCheck('echo hello ^| goodbye', 'win32').verdict,
      'explicitly_safe',
    );
  });

  it('returns not_analyzed for backtick (defer to regex)', () => {
    const result = contextAwareOperatorCheck('npm `whoami`', 'win32');
    assert.equal(result.verdict, 'not_analyzed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Integration: commands that regex rejects but tokenizer allows
// ═══════════════════════════════════════════════════════════════════════════════

describe('tokenizer reduces false positives from regex', () => {
  // The regex SHELL_OPERATOR_RE matches ALL operator characters regardless
  // of context. The tokenizer allows through those in safe contexts.

  it('allows & inside double quotes (regex would reject)', () => {
    // SHELL_OPERATOR_RE would match '&' here, but it's inside quotes
    const result = tokenizeCmdCommand('echo "install & build"');
    assert.equal(result.safe, true);
  });

  it('allows > inside double quotes (regex would reject)', () => {
    const result = tokenizeCmdCommand('echo "a > b"');
    assert.equal(result.safe, true);
  });

  it('allows caret-escaped pipe (regex would reject)', () => {
    const result = tokenizeCmdCommand('echo hello ^| world');
    assert.equal(result.safe, true);
  });
});

// ── cd-prefix pattern tests ─────────────────────────────────────────────────

describe('cd / chdir / pushd prefix with &&', () => {
  it('allows cd <path> && npm test', () => {
    const result = tokenizeCmdCommand(
      'cd /tmp/project && npm test',
    );
    assert.equal(result.safe, true);
  });

  it('allows cd <path> && python -m pytest', () => {
    const result = tokenizeCmdCommand(
      'cd C:\\workspace && python -m pytest tests/ -v -x -q',
    );
    assert.equal(result.safe, true);
  });

  it('allows chdir with &&', () => {
    const result = tokenizeCmdCommand(
      'chdir /d D:\\repo && cargo test',
    );
    assert.equal(result.safe, true);
  });

  it('allows pushd with &&', () => {
    const result = tokenizeCmdCommand(
      'pushd C:\\project && node -e "1+1"',
    );
    assert.equal(result.safe, true);
  });

  it('still rejects standalone && outside cd prefix', () => {
    const result = tokenizeCmdCommand('npm test && npm run build');
    assert.equal(result.safe, false);
  });

  it('still rejects pipe even after cd prefix', () => {
    const result = tokenizeCmdCommand(
      'cd C:\\project && npm test | findstr FAIL',
    );
    assert.equal(result.safe, false);
    assert.ok(result.reason?.includes('always dangerous'));
  });

  it('rejects cd && with dangerous chars in right side', () => {
    const result = tokenizeCmdCommand(
      'cd C:\\workspace && npm test > C:\\out.txt',
    );
    assert.equal(result.safe, false);
    assert.ok(result.reason?.toLowerCase().includes('redirect'));
  });

  it('allows python -c with semicolons inside quotes', () => {
    const result = tokenizeCmdCommand(
      'python -c "import sys; sys.path.insert(0, \'.\'); print(\'ok\')"',
    );
    assert.equal(result.safe, true);
  });

  it('rejects semicolon outside quotes', () => {
    const result = tokenizeCmdCommand('echo hello; echo world');
    assert.equal(result.safe, false);
  });
});
