import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTextToolTurn } from './textToolParser.js';

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

// ─── New tools ──────────────────────────────────────────────────────────────

test('parses [TOOL:think] with thought text', () => {
  const input = '[TOOL:think]\nthought: The bug is a null reference in auth.';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'think');
  assert.equal((result.actions![0] as any).thought, 'The bug is a null reference in auth.');
});

test('parses [TOOL:think] with multi-line thought', () => {
  const input = [
    '[TOOL:think]',
    'thought:',
    '  First, I need to check the auth guard.',
    '  The null reference is likely on line 42.',
  ].join('\n');
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal((result.actions![0] as any).thought, 'First, I need to check the auth guard.\nThe null reference is likely on line 42.');
});

test('parses [TOOL:ask] with question', () => {
  const input = '[TOOL:ask]\nquestion: Should I use npm or pnpm?';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'ask');
  assert.equal((result.actions![0] as any).question, 'Should I use npm or pnpm?');
});

test('parses [TOOL:remember] with key and multi-line value', () => {
  const input = [
    '[TOOL:remember]',
    'key: project_config',
    'value:',
    '  Framework: React 18',
    '  Package manager: npm',
  ].join('\n');
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'remember');
  assert.equal((result.actions![0] as any).key, 'project_config');
  assert.equal(
    (result.actions![0] as any).value,
    'Framework: React 18\nPackage manager: npm',
  );
});

test('parses [TOOL:recall] with key', () => {
  const input = '[TOOL:recall]\nkey: project_config';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'recall');
  assert.equal((result.actions![0] as any).key, 'project_config');
});

test('parses [TOOL:check] with file_path', () => {
  const input = '[TOOL:check]\nfile_path: src/utils/validator.ts';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'check');
  assert.equal((result.actions![0] as any).file_path, 'src/utils/validator.ts');
});

test('parses [TOOL:plan] with multi-line steps', () => {
  const input = [
    '[TOOL:plan]',
    'steps:',
    '  1. Read the current auth middleware',
    '  2. Identify the null reference',
    '  3. Apply the fix',
  ].join('\n');
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 1);
  assert.equal(result.actions![0]!.type, 'plan');
  assert.equal(
    (result.actions![0] as any).steps,
    '1. Read the current auth middleware\n2. Identify the null reference\n3. Apply the fix',
  );
});

// ─── New tool required param missing ────────────────────────────────────────

test('think with missing thought param still produces action (lenient)', () => {
  const input = [
    '[TOOL:think]',
    'wrong_key: some text',
    '',
    '[TOOL:grep]',
    'pattern: TODO',
  ].join('\n');
  const result = parseTextToolTurn(input);

  // Lenient: think always produces a valid action with default thought
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 2);
  assert.equal(result.actions![0]!.type, 'think');
  assert.equal((result.actions![0] as any).thought, '(thinking)');
  assert.equal(result.actions![1]!.type, 'grep');
});

test('ask with missing question param still produces ask action (lenient)', () => {
  const input = '[TOOL:ask]\nother: junk';
  const result = parseTextToolTurn(input);

  // Lenient: ask always produces a valid action with a default question
  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions![0]!.type, 'ask');
  assert.equal((result.actions![0] as any).question, 'What should I do next?');
});

test('remember with missing key or value is skipped gracefully', () => {
  const input = '[TOOL:remember]\nkey: my_key';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
});

test('recall with missing key is skipped gracefully', () => {
  const input = '[TOOL:recall]';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
});

test('check with missing file_path is skipped gracefully', () => {
  const input = '[TOOL:check]\nother: junk';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
});

test('plan with missing steps is skipped gracefully', () => {
  const input = '[TOOL:plan]\nother: junk';
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'completion');
});

// ─── Multi-tool with new tools ─────────────────────────────────────────────

test('parses multiple tool blocks mixing old and new tools', () => {
  const input = [
    '[TOOL:think]',
    'thought: I need to investigate the auth module.',
    '',
    '[TOOL:read_file]',
    'path: src/auth.ts',
    '',
    '[TOOL:grep]',
    'pattern: null',
    'path: src/auth.ts',
    '',
    '[TOOL:finish]',
  ].join('\n');
  const result = parseTextToolTurn(input);

  assert.equal(result.type, 'tool_calls');
  assert.equal(result.actions?.length, 4);
  assert.equal(result.actions![0]!.type, 'think');
  assert.equal(result.actions![1]!.type, 'read_file');
  assert.equal(result.actions![2]!.type, 'grep');
  assert.equal(result.actions![3]!.type, 'finish');
});
