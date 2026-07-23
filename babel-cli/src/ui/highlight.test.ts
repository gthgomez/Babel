/**
 * highlight.test.ts — Comprehensive tests for syntax highlighting and
 * markdown rendering functions from highlight.ts.
 *
 * Pure functions (langFromExtension) use inline assertions.
 * ANSI-producing functions use subprocess spawning with FORCE_COLOR=1
 * to get deterministic color output regardless of the test runner's TTY.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  langFromExtension,
  normalizeHighlightLang,
  isRegexHighlightSupported,
  getHighlightLanguageMatrix,
  REGEX_HIGHLIGHT_FAMILIES,
} from './highlight.js';

// ─── Subprocess helper ──────────────────────────────────────────────────────
// All ANSI-producing functions must run in a subprocess with FORCE_COLOR=1
// so that `supportsColor()` in theme.ts returns true deterministically.

const SUBPROCESS_CWD = process.cwd();

function subprocessEval(scriptBody: string): string {
  const script = [
    `import { highlightLine, highlightCodeBlocks, renderMarkdown } from './src/ui/highlight.js';`,
    scriptBody,
  ].join('\n');

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: SUBPROCESS_CWD,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      NO_COLOR: '',
      PATH: process.env.PATH,
    },
    timeout: 15_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `Subprocess exited with status ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`,
    );
  }

  return JSON.parse(result.stdout.trim());
}

function runHighlight(line: string, lang?: string): string {
  const escaped = JSON.stringify(line);
  const langExpr = lang !== undefined ? JSON.stringify(lang) : 'undefined';
  return subprocessEval(`console.log(JSON.stringify(highlightLine(${escaped}, ${langExpr})));`);
}

function runCodeBlocks(text: string): string {
  return subprocessEval(
    `console.log(JSON.stringify(highlightCodeBlocks(${JSON.stringify(text)})));`,
  );
}

function runMarkdown(text: string): string {
  return subprocessEval(`console.log(JSON.stringify(renderMarkdown(${JSON.stringify(text)})));`);
}

// Assert helpers

function assertHasAnsi(output: string): void {
  assert.match(output, /\x1b\[/, 'Expected ANSI escape codes to be present');
}

function assertNoAnsi(output: string): void {
  assert.doesNotMatch(output, /\x1b\[/, 'Expected no ANSI escape codes');
}

function assertTextContent(output: string, text: string): void {
  // Strip ANSI codes and check the plain text contains the expected string
  const plain = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x1b\\/g, '');
  assert.ok(plain.includes(text), `Expected "${text}" in plain text "${plain}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// langFromExtension — pure function, no subprocess needed
// ═══════════════════════════════════════════════════════════════════════════════

test('langFromExtension: .ts → typescript', () => {
  assert.equal(langFromExtension('foo.ts'), 'typescript');
});

test('langFromExtension: .tsx → typescript', () => {
  assert.equal(langFromExtension('foo.tsx'), 'typescript');
});

test('langFromExtension: .js → javascript', () => {
  assert.equal(langFromExtension('foo.js'), 'javascript');
});

test('langFromExtension: .jsx → javascript', () => {
  assert.equal(langFromExtension('foo.jsx'), 'javascript');
});

test('langFromExtension: .mjs → javascript', () => {
  assert.equal(langFromExtension('foo.mjs'), 'javascript');
});

test('langFromExtension: .cjs → javascript', () => {
  assert.equal(langFromExtension('foo.cjs'), 'javascript');
});

test('langFromExtension: .py → python', () => {
  assert.equal(langFromExtension('foo.py'), 'python');
});

test('langFromExtension: .rs → rust', () => {
  assert.equal(langFromExtension('foo.rs'), 'rust');
});

test('langFromExtension: .go → go', () => {
  assert.equal(langFromExtension('foo.go'), 'go');
});

test('langFromExtension: .json → json', () => {
  assert.equal(langFromExtension('foo.json'), 'json');
});

test('langFromExtension: .yaml → yaml', () => {
  assert.equal(langFromExtension('foo.yaml'), 'yaml');
});

test('langFromExtension: .yml → yaml', () => {
  assert.equal(langFromExtension('foo.yml'), 'yaml');
});

test('langFromExtension: .md → markdown', () => {
  assert.equal(langFromExtension('foo.md'), 'markdown');
});

test('langFromExtension: .css → css', () => {
  assert.equal(langFromExtension('foo.css'), 'css');
});

test('langFromExtension: .html → html', () => {
  assert.equal(langFromExtension('foo.html'), 'html');
});

test('langFromExtension: .sh → bash', () => {
  assert.equal(langFromExtension('foo.sh'), 'bash');
});

test('langFromExtension: .sql → sql', () => {
  assert.equal(langFromExtension('foo.sql'), 'sql');
});

test('langFromExtension: .toml → toml', () => {
  assert.equal(langFromExtension('foo.toml'), 'toml');
});

test('langFromExtension: unknown extension → empty string', () => {
  assert.equal(langFromExtension('foo.txt'), '');
});

// ═══════════════════════════════════════════════════════════════════════════════
// G1 — hybrid language matrix + aliases
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizeHighlightLang maps aliases to families', () => {
  assert.equal(normalizeHighlightLang('bash'), 'shell');
  assert.equal(normalizeHighlightLang('ps1'), 'powershell');
  assert.equal(normalizeHighlightLang('yml'), 'yaml');
  assert.equal(normalizeHighlightLang('cs'), 'csharp');
  assert.equal(normalizeHighlightLang('unknownlang'), '');
});

test('isRegexHighlightSupported covers expanded G1 families', () => {
  for (const fam of ['shell', 'sql', 'java', 'csharp', 'ruby', 'php', 'html', 'css', 'toml', 'powershell']) {
    assert.equal(isRegexHighlightSupported(fam), true, fam);
  }
  assert.equal(isRegexHighlightSupported('brainfuck'), false);
});

test('getHighlightLanguageMatrix exposes honest family list', () => {
  const m = getHighlightLanguageMatrix();
  assert.ok(m.regexFamilies.includes('shell'));
  assert.ok(m.regexFamilies.length === REGEX_HIGHLIGHT_FAMILIES.length);
  assert.equal(m.aliases['bash'], 'shell');
});

test('highlightLine: shell keywords colored', () => {
  const out = runHighlight('if true; then echo hi; fi', 'bash');
  assertHasAnsi(out);
  assertTextContent(out, 'if');
  assertTextContent(out, 'echo');
});

test('highlightLine: SQL case-insensitive keywords colored', () => {
  const out = runHighlight('SELECT id FROM users WHERE active = true', 'sql');
  assertHasAnsi(out);
  assertTextContent(out, 'SELECT');
  assertTextContent(out, 'FROM');
});

test('highlightLine: powershell keywords colored', () => {
  const out = runHighlight('function Get-Thing { param($Name) return $Name }', 'ps1');
  assertHasAnsi(out);
  assertTextContent(out, 'function');
  assertTextContent(out, 'param');
});

test('highlightLine: unknown lang still safe (no throw)', () => {
  const out = runHighlight('plain code', 'brainfuck');
  assertTextContent(out, 'plain code');
});

test('langFromExtension: empty string → empty string', () => {
  assert.equal(langFromExtension(''), '');
});

test('langFromExtension: full path extracts extension', () => {
  assert.equal(langFromExtension('/path/to/file.ts'), 'typescript');
});

test('langFromExtension: windows path extracts extension', () => {
  assert.equal(langFromExtension('C:\\path\\to\\file.py'), 'python');
});

// ═══════════════════════════════════════════════════════════════════════════════
// highlightLine
// ═══════════════════════════════════════════════════════════════════════════════

test('highlightLine: TypeScript keywords get colored', () => {
  const out = runHighlight('const x = 1');
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
});

test('highlightLine: TypeScript types get colored', () => {
  const out = runHighlight('let x: string = "hello"');
  assertHasAnsi(out);
  assertTextContent(out, 'let x: string = "hello"');
});

test('highlightLine: double-quoted strings get colored', () => {
  const out = runHighlight('const msg = "hello world"');
  assertHasAnsi(out);
  assertTextContent(out, 'const msg = "hello world"');
});

test('highlightLine: single-quoted strings get colored', () => {
  const out = runHighlight("const msg = 'hello world'");
  assertHasAnsi(out);
  assertTextContent(out, "const msg = 'hello world'");
});

test('highlightLine: backtick templates get colored', () => {
  const out = runHighlight('const msg = `hello ${name}`');
  assertHasAnsi(out);
  assertTextContent(out, 'const msg = `hello ${name}`');
});

test('highlightLine: comments get dimmed', () => {
  const out = runHighlight('const x = 1; // this is a comment');
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1; // this is a comment');
  // Comment should be wrapped in dim sequences
  assert.match(out, /\x1b\[2m\/\/ this is a comment\x1b\[0m/);
});

test('highlightLine: TypeScript function keyword', () => {
  const out = runHighlight('function greet(name: string): void {}');
  assertHasAnsi(out);
  assertTextContent(out, 'function greet(name: string): void {}');
});

test('highlightLine: TypeScript class keyword', () => {
  const out = runHighlight('class Animal implements Serializable {}');
  assertHasAnsi(out);
  assertTextContent(out, 'class Animal implements Serializable {}');
});

test('highlightLine: TypeScript import/export keywords', () => {
  const out = runHighlight('import { foo } from "./bar"; export default foo;');
  assertHasAnsi(out);
  assertTextContent(out, 'import { foo } from "./bar"; export default foo;');
});

test('highlightLine: TypeScript async/await', () => {
  const out = runHighlight(
    'async function fetchData(): Promise<unknown> { return await api.get(); }',
  );
  assertHasAnsi(out);
  assertTextContent(out, 'async function fetchData(): Promise<unknown>');
});

test('highlightLine: TypeScript try/catch/throw', () => {
  const out = runHighlight('try { throw new Error("fail"); } catch (e) {}');
  assertHasAnsi(out);
  assertTextContent(out, 'try { throw new Error("fail"); } catch (e) {}');
});

test('highlightLine: Python keywords', () => {
  const out = runHighlight('def greet(name: str) -> str:\n    return f"Hello {name}"', 'py');
  assertHasAnsi(out);
  assertTextContent(out, 'def greet(name: str) -> str:');
});

test('highlightLine: Python class and method', () => {
  const out = runHighlight('class MyClass:\n    def __init__(self):\n        pass', 'py');
  assertHasAnsi(out);
  assertTextContent(out, 'class MyClass:');
});

test('highlightLine: Python None/True/False', () => {
  const out = runHighlight('x = None\ny = True\nz = False', 'py');
  assertHasAnsi(out);
  assertTextContent(out, 'x = None');
});

test('highlightLine: Python import/from', () => {
  const out = runHighlight('import os\nfrom pathlib import Path', 'py');
  assertHasAnsi(out);
  assertTextContent(out, 'import os');
});

test('highlightLine: Python try/except/raise', () => {
  const out = runHighlight(
    'try:\n    raise ValueError("bad")\nexcept Exception as e:\n    pass',
    'py',
  );
  assertHasAnsi(out);
  assertTextContent(out, 'try:');
});

test('highlightLine: Python types', () => {
  const out = runHighlight('def process(items: list[int]) -> dict[str, bool]:', 'py');
  assertHasAnsi(out);
  assertTextContent(out, 'def process(items: list[int]) -> dict[str, bool]:');
});

test('highlightLine: Rust fn and let', () => {
  const out = runHighlight('fn main() -> i32 {\n    let x = 42;\n    return x;\n}', 'rs');
  assertHasAnsi(out);
  assertTextContent(out, 'fn main() -> i32 {');
});

test('highlightLine: Rust struct and impl', () => {
  const out = runHighlight(
    'struct Point {\n    x: i32,\n    y: i32,\n}\n\nimpl Point { fn new(x: i32, y: i32) -> Self {',
    'rs',
  );
  assertHasAnsi(out);
  assertTextContent(out, 'struct Point {');
});

test('highlightLine: Rust pub use mod', () => {
  const out = runHighlight('pub use crate::module::Type;\nmod internal;', 'rs');
  assertHasAnsi(out);
  assertTextContent(out, 'pub use crate::module::Type;');
});

test('highlightLine: Rust generic types (Option, Result)', () => {
  const out = runHighlight('fn parse(s: &str) -> Result<i32, String> {', 'rs');
  assertHasAnsi(out);
  assertTextContent(out, 'fn parse(s: &str) -> Result<i32, String> {');
});

test('highlightLine: Go func and package', () => {
  const out = runHighlight('package main\n\nfunc main() {\n    fmt.Println("hello")\n}', 'go');
  assertHasAnsi(out);
  assertTextContent(out, 'package main');
});

test('highlightLine: Go types and struct', () => {
  const out = runHighlight('type Person struct {\n    Name string\n    Age  int\n}', 'go');
  assertHasAnsi(out);
  assertTextContent(out, 'type Person struct {');
});

test('highlightLine: Go defer and go keywords', () => {
  const out = runHighlight('func process() {\n    defer close(f)\n    go worker()\n}', 'go');
  assertHasAnsi(out);
  assertTextContent(out, 'func process() {');
});

test('highlightLine: Go var const range', () => {
  const out = runHighlight('var count = 0\nconst MAX = 100\nfor i, v := range items {', 'go');
  assertHasAnsi(out);
  assertTextContent(out, 'var count = 0');
});

test('highlightLine: JSON true/false/null', () => {
  const out = runHighlight('{"active": true, "disabled": false, "value": null}', 'json');
  assertHasAnsi(out);
  assertTextContent(out, '{"active": true, "disabled": false, "value": null}');
});

test('highlightLine: YAML key-value with boolean', () => {
  const out = runHighlight('enabled: true', 'yaml');
  assertHasAnsi(out);
  assertTextContent(out, 'enabled: true');
});

test('highlightLine: YAML key-value with string', () => {
  const out = runHighlight('name: "Alice"', 'yaml');
  assertHasAnsi(out);
  assertTextContent(out, '"Alice"');
});

test('highlightLine: YAML key-value with number', () => {
  const out = runHighlight('count: 42', 'yaml');
  assertHasAnsi(out);
  assertTextContent(out, 'count: 42');
});

test('highlightLine: YAML comment line', () => {
  const out = runHighlight('# this is a yaml comment', 'yaml');
  assertHasAnsi(out);
  assertTextContent(out, '# this is a yaml comment');
});

test('highlightLine: YAML list item', () => {
  const out = runHighlight('  - item', 'yaml');
  assertHasAnsi(out);
  assertTextContent(out, '  - item');
});

test('highlightLine: empty string returns empty', () => {
  const out = runHighlight('');
  assert.equal(out, '');
});

test('highlightLine: no language tag defaults to TypeScript', () => {
  const out = runHighlight('const x = 1');
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
});

test('highlightLine: text without known tokens passes through unchanged', () => {
  // When no keywords or types match in the text, no ANSI codes are emitted.
  // The `dim` behavior for unknown languages in code blocks is tested
  // separately in the highlightCodeBlocks section.
  const input = 'plain text no keywords';
  const out = runHighlight(input);
  assert.equal(out, input);
});

// ═══════════════════════════════════════════════════════════════════════════════
// highlightCodeBlocks
// ═══════════════════════════════════════════════════════════════════════════════

test('highlightCodeBlocks: fenced block with language tag', () => {
  const out = runCodeBlocks('```ts\nconst x = 1\n```');
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
  // Fence markers should be preserved
  assert.ok(out.includes('```'), 'Fence markers should be preserved');
});

test('highlightCodeBlocks: fenced block without language tag', () => {
  const input = '```\nplain code\n```';
  const out = runCodeBlocks(input);
  assertTextContent(out, 'plain code');
  // No language tag → no highlighting applied, passes through as-is
  assert.equal(out, input);
});

test('highlightCodeBlocks: unknown language produces dim output', () => {
  const out = runCodeBlocks('```unknown\nsome text\n```');
  assertHasAnsi(out);
  assertTextContent(out, 'some text');
  // With unknown language, the code block line should be dimmed
  assert.match(out, /\x1b\[2msome text\x1b\[22m/);
});

test('highlightCodeBlocks: multiple code blocks', () => {
  const out = runCodeBlocks('```ts\nconst x = 1\n```\n\ntext\n\n```py\ndef foo():\n    pass\n```');
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
  assertTextContent(out, 'def foo():');
  // Count the fence markers
  const fenceCount = (out.match(/```/g) || []).length;
  assert.equal(fenceCount, 4);
});

test('highlightCodeBlocks: mixed text and code blocks', () => {
  const out = runCodeBlocks('Here is some text\n\n```ts\nconst x = 1\n```\n\nAnd more text');
  assertHasAnsi(out);
  assertTextContent(out, 'Here is some text');
  assertTextContent(out, 'const x = 1');
  assertTextContent(out, 'And more text');
});

test('highlightCodeBlocks: no code blocks returns text unchanged', () => {
  const input = 'This is just plain text\nwith no code fences at all.';
  const out = runCodeBlocks(input);
  assert.equal(out, input);
});

test('highlightCodeBlocks: unclosed code fence', () => {
  const out = runCodeBlocks('```ts\nconst x = 1');
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
  // The block stays "open", content still gets highlighted
  assert.ok(out.includes('```'), 'Opening fence preserved');
});

// ═══════════════════════════════════════════════════════════════════════════════
// renderMarkdown
// ═══════════════════════════════════════════════════════════════════════════════

test('renderMarkdown: heading H1', () => {
  const out = runMarkdown('# Hello');
  assertHasAnsi(out);
  assertTextContent(out, 'Hello');
});

test('renderMarkdown: heading H2', () => {
  const out = runMarkdown('## Subtitle');
  assertHasAnsi(out);
  assertTextContent(out, 'Subtitle');
});

test('renderMarkdown: heading H3', () => {
  const out = runMarkdown('### Section');
  assertHasAnsi(out);
  assertTextContent(out, 'Section');
});

test('renderMarkdown: bold text', () => {
  const out = runMarkdown('**bold**');
  assertHasAnsi(out);
  assertTextContent(out, 'bold');
});

test('renderMarkdown: italic text', () => {
  const out = runMarkdown('*italic*');
  assertHasAnsi(out);
  assertTextContent(out, 'italic');
  // Italic should use the ANSI italic open/close codes
  assert.match(out, /\x1b\[3mitalic\x1b\[23m/);
});

test('renderMarkdown: code span', () => {
  const out = runMarkdown('Use `code` inline');
  assertHasAnsi(out);
  assertTextContent(out, 'Use code inline');
});

test('renderMarkdown: link produces OSC 8 hyperlink', () => {
  const out = runMarkdown('[text](https://example.com)');
  assertHasAnsi(out);
  assertTextContent(out, 'text');
  assertTextContent(out, 'https://example.com');
  // OSC 8 sequences
  assert.match(out, /\x1b\]8;;/);
});

test('renderMarkdown: unordered list', () => {
  const out = runMarkdown('- item one\n- item two\n- item three');
  assertHasAnsi(out);
  assertTextContent(out, 'item one');
  assertTextContent(out, 'item two');
  assertTextContent(out, 'item three');
});

test('renderMarkdown: ordered list', () => {
  const out = runMarkdown('1. first\n2. second\n3. third');
  assertHasAnsi(out);
  assertTextContent(out, 'first');
  assertTextContent(out, 'second');
  assertTextContent(out, 'third');
});

test('renderMarkdown: blockquote', () => {
  const out = runMarkdown('> quoted text');
  assertHasAnsi(out);
  assertTextContent(out, 'quoted text');
  // Blockquote uses dim │ prefix
  assert.match(out, /│/);
});

test('renderMarkdown: table', () => {
  const out = runMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assertTextContent(out, 'A');
  assertTextContent(out, 'B');
  assertTextContent(out, '1');
  assertTextContent(out, '2');
  // Table uses box-drawing characters for alignment
  assert.match(out, /[│┼├┤]/);
});

test('renderMarkdown: horizontal rule', () => {
  const out = runMarkdown('---');
  assertHasAnsi(out);
  // HR produces dimmed ─ characters
  assert.match(out, /\x1b\[2m─+\x1b\[22m/);
});

test('renderMarkdown: inline formatting combinations (bold + italic)', () => {
  const out = runMarkdown('**bold *italic* text**');
  assertHasAnsi(out);
  assertTextContent(out, 'bold italic text');
});

test('renderMarkdown: plain text passes through unchanged when no markdown syntax', () => {
  const input = 'Just plain text without any markdown syntax.';
  const out = runMarkdown(input);
  // No ANSI codes expected since the fast-path returns text unchanged
  assertNoAnsi(out);
  assert.equal(out, input);
});

test('renderMarkdown: empty string returns empty', () => {
  const out = runMarkdown('');
  assert.equal(out, '');
});

test('renderMarkdown: code block inside markdown', () => {
  const out = runMarkdown('Here is code:\n```ts\nconst x = 1\n```\nEnd.');
  assertHasAnsi(out);
  assertTextContent(out, 'Here is code:');
  assertTextContent(out, 'const x = 1');
  assertTextContent(out, 'End.');
});

test('renderMarkdown: multiple paragraphs', () => {
  const out = runMarkdown('First paragraph.\n\nSecond paragraph.');
  assertTextContent(out, 'First paragraph.');
  assertTextContent(out, 'Second paragraph.');
  // Simple paragraph text gets no ANSI (no markdown syntax in words)
  // But paragraphs may get ANSI depending on content — just verify text
});

test('renderMarkdown: strikethrough text', () => {
  const out = runMarkdown('~~deleted~~');
  assertHasAnsi(out);
  assertTextContent(out, 'deleted');
});

test('renderMarkdown: image renders as dim placeholder', () => {
  const out = runMarkdown('![alt](img.png)');
  assertHasAnsi(out);
  assertTextContent(out, 'image: img.png');
});

test('renderMarkdown: headings with different levels keep distinct formatting', () => {
  const out = runMarkdown('# H1\n\n## H2\n\n### H3');
  assertHasAnsi(out);
  assertTextContent(out, 'H1');
  assertTextContent(out, 'H2');
  assertTextContent(out, 'H3');
});

test('renderMarkdown: nested blockquotes', () => {
  const out = runMarkdown('> Outer\n> > Inner');
  assertHasAnsi(out);
  assertTextContent(out, 'Outer');
  assertTextContent(out, 'Inner');
});

test('renderMarkdown: bold inside heading', () => {
  const out = runMarkdown('# **Important** Heading');
  assertHasAnsi(out);
  assertTextContent(out, 'Important Heading');
});

test('renderMarkdown: code span with special chars', () => {
  const out = runMarkdown('Use `foo.bar()` for this.');
  assertHasAnsi(out);
  assertTextContent(out, 'Use foo.bar() for this.');
});

test('renderMarkdown: link with nested formatting', () => {
  const out = runMarkdown('[**bold link**](https://example.com)');
  assertHasAnsi(out);
  assertTextContent(out, 'bold link');
  assertTextContent(out, 'https://example.com');
});
