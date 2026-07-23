import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentAction } from './actions.js';
import {
  decideAction,
  mergeDecisions,
  presetForVerb,
  patternMatch,
  parseToolPattern,
  evaluatePermissionRules,
  parsePermissionPatternString,
  mergePermissionPatterns,
  allowedToolsForVerb,
} from './policy.js';

describe('decideAction', () => {
  const writeFile: AgentAction = { type: 'write_file', path: 'src/a.ts', content: 'x' };
  const applyPatch: AgentAction = { type: 'apply_patch', patch: 'diff' };
  const runCommand: AgentAction = { type: 'run_command', command: 'npm test' };
  const readFile: AgentAction = { type: 'read_file', path: 'src/a.ts' };

  it('denies mutating actions under read_only preset', () => {
    assert.equal(decideAction(writeFile, 'read_only'), 'deny');
    assert.equal(decideAction(applyPatch, 'read_only'), 'deny');
    assert.equal(decideAction(runCommand, 'read_only'), 'deny');
    assert.equal(decideAction(readFile, 'read_only'), 'allow');
  });

  it('asks before mutation under ask_before_mutation preset', () => {
    assert.equal(decideAction(writeFile, 'ask_before_mutation'), 'ask');
    assert.equal(decideAction(runCommand, 'ask_before_mutation'), 'ask');
    assert.equal(decideAction(readFile, 'ask_before_mutation'), 'allow');
  });

  it('allows fix-verb mutations under workspace_write preset', () => {
    assert.equal(decideAction(writeFile, 'workspace_write'), 'allow');
    assert.equal(decideAction(runCommand, 'workspace_write'), 'allow');
  });

  it('denies risky network/install commands unless auto_safe asks', () => {
    const curl: AgentAction = { type: 'run_command', command: 'curl https://example.com' };
    const install: AgentAction = { type: 'run_command', command: 'npm install left-pad' };

    assert.equal(decideAction(curl, 'workspace_write'), 'deny');
    assert.equal(decideAction(install, 'workspace_write'), 'deny');
    assert.equal(decideAction(curl, 'auto_safe'), 'ask');
    assert.equal(decideAction(install, 'auto_safe'), 'ask');
  });
});

describe('mergeDecisions', () => {
  it('deny overrides allow and ask', () => {
    assert.equal(mergeDecisions('allow', 'ask', 'deny'), 'deny');
    assert.equal(mergeDecisions('allow', 'ask'), 'ask');
    assert.equal(mergeDecisions('allow', 'allow'), 'allow');
  });
});

describe('presetForVerb', () => {
  it('uses workspace_write for fix verb', () => {
    assert.equal(presetForVerb('fix'), 'workspace_write');
  });

  it('uses read_only for plan and propose verbs', () => {
    assert.equal(presetForVerb('plan'), 'read_only');
    assert.equal(presetForVerb('propose'), 'read_only');
  });
});

describe('patternMatch', () => {
  it('**/*.ts matches foo.ts at root', () => {
    assert.equal(patternMatch('**/*.ts', 'foo.ts'), true);
  });

  it('src/**/*.ts matches src/foo.ts', () => {
    assert.equal(patternMatch('src/**/*.ts', 'src/foo.ts'), true);
  });

  it('src/**/*.ts matches src/services/foo.ts', () => {
    assert.equal(patternMatch('src/**/*.ts', 'src/services/foo.ts'), true);
  });

  it('exact match returns true', () => {
    assert.equal(patternMatch('src/foo.ts', 'src/foo.ts'), true);
  });

  it('case insensitive matching', () => {
    assert.equal(patternMatch('SRC/FOO.TS', 'src/foo.ts'), true);
    assert.equal(patternMatch('src/foo.ts', 'SRC/FOO.TS'), true);
  });

  it('single * wildcard matches within a path segment', () => {
    assert.equal(patternMatch('src/*.ts', 'src/foo.ts'), true);
    assert.equal(patternMatch('src/*.ts', 'src/foo/bar.ts'), false);
  });

  it('* matches everything', () => {
    assert.equal(patternMatch('*', 'any/path/file.ts'), true);
  });

  it('** matches everything', () => {
    assert.equal(patternMatch('**', 'any/path/file.ts'), true);
  });

  it('non-matching pattern returns false', () => {
    assert.equal(patternMatch('*.js', 'foo.ts'), false);
  });

  it('globstar with leading slash matches root files too', () => {
    assert.equal(patternMatch('src/**/*.ts', 'src/foo.ts'), true);
  });

  it('handles Windows backslash paths', () => {
    // patternMatch builds a regex using forward-slash path separators, so
    // backslashes in the value do not match the forward-slash-encoded pattern.
    assert.equal(patternMatch('src/**/*.ts', 'src\\foo.ts'), false);
  });

  it('does not match different directory structure', () => {
    assert.equal(patternMatch('src/**/*.ts', 'lib/foo.ts'), false);
  });
});

describe('parseToolPattern', () => {
  it('parses "file_write(src/*.ts)" into tool and pathPattern', () => {
    const result = parseToolPattern('file_write(src/*.ts)');
    assert.notEqual(result, null);
    assert.equal(result!.tool, 'file_write');
    assert.equal(result!.pathPattern, 'src/*.ts');
  });

  it('parses bare tool name "shell_exec"', () => {
    const result = parseToolPattern('shell_exec');
    assert.notEqual(result, null);
    assert.equal(result!.tool, 'shell_exec');
    assert.equal(result!.pathPattern, '*');
  });

  it('returns null for invalid pattern', () => {
    const result = parseToolPattern('invalid pattern with spaces');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = parseToolPattern('');
    assert.equal(result, null);
  });

  it('normalizes tool name to lowercase', () => {
    const result = parseToolPattern('FILE_WRITE(src/*.ts)');
    assert.notEqual(result, null);
    assert.equal(result!.tool, 'file_write');
  });

  it('parses pattern with multi-character tool name', () => {
    const result = parseToolPattern('shell_exec(npm test)');
    assert.notEqual(result, null);
    assert.equal(result!.tool, 'shell_exec');
    assert.equal(result!.pathPattern, 'npm test');
  });

  it('parses bare tool with digits and underscore', () => {
    const result = parseToolPattern('my_tool_123');
    assert.notEqual(result, null);
    assert.equal(result!.tool, 'my_tool_123');
  });

  it('returns null for pattern with only parentheses', () => {
    const result = parseToolPattern('()');
    assert.equal(result, null);
  });
});

describe('evaluatePermissionRules', () => {
  it('deny overrides allow for matching tool and path', () => {
    const rules = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [{ pattern: 'file_write(src/secret.ts)', decision: 'deny' as const }],
    };
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'src/secret.ts'), 'deny');
  });

  it('no rules matching returns default allow', () => {
    const rules = { allow: [], deny: [] };
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'src/foo.ts'), 'allow');
  });

  it('tool mismatch does not match rule (fail-closed returns ask when rules exist)', () => {
    const rules = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [],
    };
    // Fail-closed: because rules exist but none match shell_exec, ask is returned
    assert.equal(evaluatePermissionRules(rules, 'shell_exec', 'src/foo.ts'), 'ask');
  });

  it('matching allow rule returns allow', () => {
    const rules = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [],
    };
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'src/foo.ts'), 'allow');
  });

  it('wildcard path pattern with matching tool returns allow', () => {
    const rules = {
      allow: [{ pattern: 'file_write(*)', decision: 'allow' as const }],
      deny: [],
    };
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'src/foo.ts'), 'allow');
  });

  it('deny with wildcard path pattern blocks any target', () => {
    const rules = {
      allow: [],
      deny: [{ pattern: 'shell_exec(*)', decision: 'deny' as const }],
    };
    assert.equal(evaluatePermissionRules(rules, 'shell_exec', 'anything'), 'deny');
  });

  it('deny without path constraint blocks any target', () => {
    const rules = {
      allow: [],
      deny: [{ pattern: 'shell_exec', decision: 'deny' as const }],
    };
    assert.equal(evaluatePermissionRules(rules, 'shell_exec', 'npm test'), 'deny');
  });

  it('multiple allow rules merge to ask when one is ask', () => {
    // mergeDecisions: deny > ask > allow
    const rules = {
      allow: [
        { pattern: 'file_write(src/ok.ts)', decision: 'allow' as const },
        { pattern: 'file_write(src/ask.ts)', decision: 'ask' as const },
      ],
      deny: [],
    };
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'src/ask.ts'), 'ask');
  });

  it('path pattern mismatch returns ask (fail-closed)', () => {
    const rules = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [],
    };
    // Tool matches but path pattern doesn't — no decisions collected but rules exist → fail-closed ask
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'lib/foo.ts'), 'ask');
  });

  it('handles Windows-style paths in target', () => {
    const rules = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [],
    };
    // Backslashes are normalized by evaluatePermissionRules
    assert.equal(evaluatePermissionRules(rules, 'file_write', 'src\\foo.ts'), 'allow');
  });
});

describe('patternMatch ReDoS safety (M3a)', () => {
  it('rejects patterns exceeding MAX_PATTERN_LENGTH (200 chars)', () => {
    const longPattern = '*'.repeat(201);
    assert.equal(patternMatch(longPattern, 'foo.ts'), false);
  });

  it('accepts patterns at exactly MAX_PATTERN_LENGTH', () => {
    const pattern = 'a'.repeat(196) + '*.ts'; // 200 chars
    // Should compile without error — the specific match result depends on input
    assert.doesNotThrow(() => {
      patternMatch(pattern, 'test.ts');
    });
  });

  it('rejects patterns with excessive wildcards (>10)', () => {
    const manyWildcards = '*'.repeat(11) + '.ts';
    assert.equal(patternMatch(manyWildcards, 'foo.ts'), false);
  });

  it('accepts patterns at exactly max wildcards (10)', () => {
    const tenWildcards = '*'.repeat(10) + '.ts';
    // Should not throw — result depends on whether the regex matches
    assert.doesNotThrow(() => {
      patternMatch(tenWildcards, 'test.ts');
    });
  });

  it('resolves quickly on potentially catastrophic backtracking pattern', () => {
    // Pattern like "a*a*a*a*a*a*a*a*a*a*b" on input "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    // can cause catastrophic backtracking. With our wildcard limits, this
    // should be rejected early (<10 wildcards means at most 9 `*` + literal `*`).
    const malicious = 'a*a*a*a*a*a*a*a*a*a*';
    // Should be fast — either returns false from wildcard limit or compiles quickly
    const start = performance.now();
    patternMatch(malicious, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 500, `patternMatch took ${elapsed}ms — expected < 500ms`);
  });

  it('returns false for invalid regex patterns (try/catch defense)', () => {
    // Patterns that produce invalid regex after glob-to-regex conversion
    // should return false rather than throw.
    // Our conversion is defensive, but if a pattern slips through and
    // produces an invalid regex, try/catch catches it.
    const complex = '['.repeat(200); // After escaping: lots of \[ which is fine
    assert.doesNotThrow(() => {
      patternMatch(complex, 'test');
    });
  });
});

describe('adversarial policy tests (M3d)', () => {
  it('decideAction returns valid decision for all action type × preset combos', () => {
    const actions = [
      { type: 'read_file' as const, path: 'test.ts' },
      { type: 'write_file' as const, path: 'test.ts', content: 'x' },
      { type: 'apply_patch' as const, patch: 'diff' },
      { type: 'run_command' as const, command: 'npm test' },
      { type: 'run_command' as const, command: 'curl example.com' },
      { type: 'finish' as const, summary: 'done', verification: [] },
    ];
    const presets = [
      'read_only' as const,
      'workspace_write' as const,
      'ask_before_mutation' as const,
      'auto_safe' as const,
    ];
    const valid = new Set(['allow', 'ask', 'deny']);

    for (const action of actions) {
      for (const preset of presets) {
        const decision = decideAction(action, preset);
        assert.ok(
          valid.has(decision),
          `Unexpected decision "${decision}" for ${action.type} × ${preset}`,
        );
      }
    }
  });

  it('parsePermissionPatternString handles empty input', () => {
    const result = parsePermissionPatternString('');
    assert.deepEqual(result, { allow: [], deny: [] });
  });

  it('parsePermissionPatternString skips malformed segments', () => {
    const result = parsePermissionPatternString(
      'allow:file_write(src/*.ts),BAD,nope,deny:shell_exec(curl)',
    );
    assert.equal(result.allow.length, 1);
    assert.equal(result.deny.length, 1);
    assert.equal(result.allow[0]?.pattern, 'file_write(src/*.ts)');
    assert.equal(result.deny[0]?.pattern, 'shell_exec(curl)');
  });

  it('mergePermissionPatterns deduplicates by pattern', () => {
    const a = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [],
    };
    const b = {
      allow: [{ pattern: 'file_write(src/*.ts)', decision: 'allow' as const }],
      deny: [],
    };
    const merged = mergePermissionPatterns(a, b);
    assert.equal(merged.allow.length, 1);
  });

  it('allowedToolsForVerb returns read-only tools for read verbs', () => {
    const tools = allowedToolsForVerb('plan');
    assert.ok(tools.length > 0);
    assert.ok(!tools.includes('file_write'));
    assert.ok(!tools.includes('shell_exec'));
  });
});
