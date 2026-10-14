import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTextToolTurn,
  buildTextToolProtocolSection,
  TEXT_TOOL_ARGUMENT_SHAPES,
  TEXT_TOOL_NAMES,
  TEXT_TOOL_PROTOCOL_SECTION,
  isUnresolvedTextToolAttempt,
  buildTextToolProtocolRejectMessage,
} from './textToolParser.js';

test('text protocol manual documents every parser tool and its accepted fields', () => {
  assert.deepEqual(new Set(Object.keys(TEXT_TOOL_ARGUMENT_SHAPES)), TEXT_TOOL_NAMES);
  for (const [name, fields] of Object.entries(TEXT_TOOL_ARGUMENT_SHAPES)) {
    assert.ok(TEXT_TOOL_PROTOCOL_SECTION.includes(`- ${name}: ${fields}`));
  }
  assert.match(TEXT_TOOL_PROTOCOL_SECTION, /indent every value line by two spaces/);
  assert.match(TEXT_TOOL_PROTOCOL_SECTION, /quote arguments containing spaces/);
  assert.match(TEXT_TOOL_PROTOCOL_SECTION, /without a shell/);
});

test('documented text-tool shapes produce the corresponding supported actions', () => {
  const examples: Array<[string, string]> = [
    ['read_file', 'path: src/app.ts'],
    ['write_file', 'path: src/app.ts\ncontent:\n  export const ok = true;'],
    ['str_replace', 'file_path: src/app.ts\nold_str: old\nnew_str: new'],
    ['grep', 'pattern: needle\npath: src/'],
    ['glob', 'pattern: **/*.ts'],
    ['run_command', 'command: node "scripts/test runner.mjs" --name "happy path"'],
    ['finish', ''],
  ];

  for (const [name, fields] of examples) {
    assert.ok(TEXT_TOOL_NAMES.has(name));
    const parsed = parseTextToolTurn(`[TOOL:${name}]${fields ? `\n${fields}` : ''}`);
    assert.equal(parsed.type, 'tool_calls', name);
    assert.equal(parsed.actions?.length, 1, name);
    assert.equal(parsed.actions?.[0]?.type, name, name);
  }
});

test('retired tools are no longer advertised or parsed into actions', () => {
  for (const name of ['think', 'ask', 'remember', 'recall', 'check', 'plan']) {
    assert.equal(TEXT_TOOL_NAMES.has(name), false, `${name} must not be advertised`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(TEXT_TOOL_ARGUMENT_SHAPES, name),
      false,
      `${name} must not be documented`,
    );
    assert.doesNotMatch(TEXT_TOOL_PROTOCOL_SECTION, new RegExp(`- ${name}:`), name);
    const parsed = parseTextToolTurn(`[TOOL:${name}]\nkey: value`);
    assert.equal(parsed.type, 'completion', `${name} must not become an action`);
  }
});

test('multiline text fields preserve blank lines and additional indentation', () => {
  const parsed = parseTextToolTurn([
    '[TOOL:write_file]',
    'path: src/message.txt',
    'content:',
    '  first',
    '  ',
    '    indented third',
  ].join('\n'));
  assert.equal(parsed.type, 'tool_calls');
  assert.equal((parsed.actions?.[0] as any).content, 'first\n\n  indented third');
});

test('scoped text manual omits disallowed tools and irrelevant usage guidance', () => {
  const readOnly = buildTextToolProtocolSection(['read_file', 'grep']);
  assert.match(readOnly, /- read_file: path/);
  assert.match(readOnly, /- grep: pattern, path \(optional\)/);
  assert.doesNotMatch(readOnly, /write_file|str_replace|run_command|multi-line field|shell operators/);

  const writeOnly = buildTextToolProtocolSection(['write_file']);
  assert.match(writeOnly, /path, content \(multiline\)/);
  assert.match(writeOnly, /multi-line field/);
  assert.match(writeOnly, /\[TOOL:write_file\]/);
  assert.doesNotMatch(writeOnly, /\[TOOL:read_file\]|run_command|shell operators/);
});

test('scoped run_command manual reflects the read-only verifier constraint', () => {
  const unrestricted = buildTextToolProtocolSection(['read_file', 'run_command']);
  assert.doesNotMatch(unrestricted, /exact foreground commands/);

  const restricted = buildTextToolProtocolSection(
    ['read_file', 'run_command'],
    ['npm test', 'npm run typecheck'],
  );
  assert.match(restricted, /exact foreground commands/);
  assert.match(restricted, /`npm test`/);
  assert.match(restricted, /`npm run typecheck`/);
  assert.match(restricted, /Background and detached execution are not available/);
});

// ─── read_file ────────────────────────────────────────────────────────────────

test('parses [TOOL:read_file] with path', () => {
  const input = '[TOOL:read_file]\npath: src/auth.ts';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'read_file');
  assert.equal((result.actions![0] as any).path, 'src/auth.ts');
});

// ─── write_file ───────────────────────────────────────────────────────────────

test('parses [TOOL:write_file] with multi-line content', () => {
  const input = [
    '[TOOL:write_file]',
    'path: src/hello.ts',
    'content:',
    '  export function hello() {',
    '    return "world";',
    '  }',
  ].join('\n');

  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'write_file');
  assert.equal((result.actions![0] as any).path, 'src/hello.ts');
  assert.equal(
    (result.actions![0] as any).content,
    'export function hello() {\n  return "world";\n}',
  );
});

// ─── str_replace ──────────────────────────────────────────────────────────────

test('parses [TOOL:str_replace] with multi-line old_str and new_str', () => {
  const input = [
    '[TOOL:str_replace]',
    'file_path: src/auth.ts',
    'old_str:',
    '  if (token = null) {',
    '    return false;',
    '  }',
    'new_str:',
    '  if (token === null) {',
    '    return false;',
    '  }',
  ].join('\n');

  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'str_replace');
  assert.equal((result.actions![0] as any).file_path, 'src/auth.ts');
  assert.equal(
    (result.actions![0] as any).old_str,
    'if (token = null) {\n  return false;\n}',
  );
  assert.equal(
    (result.actions![0] as any).new_str,
    'if (token === null) {\n  return false;\n}',
  );
});

// ─── grep ─────────────────────────────────────────────────────────────────────

test('parses [TOOL:grep] with pattern and path', () => {
  const input = '[TOOL:grep]\npattern: isAuthenticated\npath: src/';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'grep');
  assert.equal((result.actions![0] as any).pattern, 'isAuthenticated');
  assert.equal((result.actions![0] as any).path, 'src/');
});

test('parses [TOOL:grep] without optional path', () => {
  const input = '[TOOL:grep]\npattern: TODO';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions![0]!.type, 'grep');
  assert.equal((result.actions![0] as any).pattern, 'TODO');
  assert.equal((result.actions![0] as any).path, undefined);
});

// ─── glob ─────────────────────────────────────────────────────────────────────

test('parses [TOOL:glob]', () => {
  const input = '[TOOL:glob]\npattern: **/*.test.ts';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions![0]!.type, 'glob');
  assert.equal((result.actions![0] as any).pattern, '**/*.test.ts');
});

// ─── run_command ──────────────────────────────────────────────────────────────

test('parses [TOOL:run_command]', () => {
  const input = '[TOOL:run_command]\ncommand: npm test';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions![0]!.type, 'run_command');
  assert.equal((result.actions![0] as any).command, 'npm test');
});

// ─── finish ───────────────────────────────────────────────────────────────────

test('parses [TOOL:finish] with no parameters', () => {
  const input = '[TOOL:finish]';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions![0]!.type, 'finish');
});

// ─── Multiple tools ───────────────────────────────────────────────────────────

test('parses multiple tool blocks in one turn', () => {
  const input = [
    '[TOOL:read_file]',
    'path: src/auth.ts',
    '',
    '[TOOL:grep]',
    'pattern: isAuthenticated',
    'path: src/',
    '',
    '[TOOL:finish]',
  ].join('\n');

  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 3);
  assert.equal(result.actions![0]!.type, 'read_file');
  assert.equal(result.actions![1]!.type, 'grep');
  assert.equal(result.actions![2]!.type, 'finish');
});

// ─── ANSWER block ─────────────────────────────────────────────────────────────

test('parses [ANSWER] block as completion', () => {
  const input = [
    '[ANSWER]',
    'The bug was on line 42.',
    'Changed `=` to `===`.',
  ].join('\n');

  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
  assert.ok(result.answer?.includes('bug was on line 42'));
});

// ─── Lenient fallbacks ────────────────────────────────────────────────────────

test('plain text without any markers is treated as completion', () => {
  const input = 'The answer is 42.';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
  assert.equal(result.answer, 'The answer is 42.');
});

test('unknown tool name is ignored, text becomes completion', () => {
  const input = '[TOOL:unknown_tool]\nparam: value';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
});

test('empty text returns polite fallback', () => {
  const result = parseTextToolTurn('');

  assert.equal(result.type, 'completion');
  assert.ok(result.answer!.length > 0);
});

test('whitespace-only text returns polite fallback', () => {
  const result = parseTextToolTurn('   \n  \n  ');

  assert.equal(result.type, 'completion');
  assert.ok(result.answer!.length > 0);
});

// ─── Missing required params ──────────────────────────────────────────────────

test('tool with missing required param is skipped gracefully', () => {
  const input = [
    '[TOOL:read_file]',
    'wrong_key: src/auth.ts',
    '',
    '[TOOL:grep]',
    'pattern: TODO',
  ].join('\n');

  const result = parseTextToolTurn(input);

  // read_file missing 'path' → skipped, grep has 'pattern' → included
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'grep');
});

// ─── Case insensitivity ───────────────────────────────────────────────────────

test('tool names are case-insensitive', () => {
  const input = '[TOOL:Read_File]\npath: src/foo.ts';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions![0]!.type, 'read_file');
});

test('parameter keys are case-insensitive', () => {
  const input = '[TOOL:read_file]\nPATH: src/foo.ts';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal((result.actions![0] as any).path, 'src/foo.ts');
});

// ─── Preamble text before first tool ──────────────────────────────────────────

test('preamble text before [TOOL:] is ignored', () => {
  const input = [
    'I will read the file now.',
    '',
    '[TOOL:read_file]',
    'path: src/auth.ts',
  ].join('\n');

  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'read_file');
});

// ─── Mixed tool and answer blocks ─────────────────────────────────────────────

test('[ANSWER] after tool blocks does not prevent tool extraction', () => {
  const input = [
    '[TOOL:read_file]',
    'path: src/auth.ts',
    '',
    '[ANSWER]',
    'Here is my analysis...',
  ].join('\n');

  const result = parseTextToolTurn(input);

  // Tool blocks take priority — if there are tools, it's a tool_calls turn
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
});

// ─── Unresolved text-tool attempts ────────────────────────────────────────────

test('isUnresolvedTextToolAttempt flags marker-without-action replies', () => {
  assert.equal(isUnresolvedTextToolAttempt('[TOOL:read_file]\npath: x'), false);
  assert.equal(isUnresolvedTextToolAttempt('[TOOL:unknown_tool]\nparam: value'), true);
  assert.equal(isUnresolvedTextToolAttempt('[TOOL:think]\nthought: hmm'), true);
  assert.equal(isUnresolvedTextToolAttempt('The answer is 42.'), false);
  assert.equal(isUnresolvedTextToolAttempt('[ANSWER]\nAll done.'), false);
  assert.equal(isUnresolvedTextToolAttempt(''), false);
});

test('buildTextToolProtocolRejectMessage names the executable tools', () => {
  const message = buildTextToolProtocolRejectMessage();
  assert.match(message, /not a valid tool call/);
  for (const name of TEXT_TOOL_NAMES) {
    assert.ok(message.includes(name), name);
  }
});
