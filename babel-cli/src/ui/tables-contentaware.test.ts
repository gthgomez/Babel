/**
 * Tests for content-aware table rendering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContentAwareTable, parsePipeTable } from './tables.js';

// ─── Pipe table parsing ─────────────────────────────────────────────────────

test('parsePipeTable parses a standard GFM pipe table', () => {
  const input = [
    '| Name | Age | City |',
    '|------|-----|------|',
    '| Alice | 30 | NY |',
    '| Bob | 25 | SF |',
  ].join('\n');

  const result = parsePipeTable(input);
  assert.ok(result !== null);
  assert.deepEqual(result!.headers, ['Name', 'Age', 'City']);
  assert.equal(result!.rows.length, 2);
  assert.deepEqual(result!.rows[0]!.cells, ['Alice', '30', 'NY']);
});

test('parsePipeTable handles tables without leading/trailing pipes', () => {
  const input = ['Name | Age', '-----|-----', 'Alice | 30'].join('\n');

  const result = parsePipeTable(input);
  assert.ok(result !== null);
  assert.deepEqual(result!.headers, ['Name', 'Age']);
  assert.equal(result!.rows.length, 1);
});

test('parsePipeTable returns null for non-table text', () => {
  assert.equal(parsePipeTable('Just some text'), null);
  assert.equal(parsePipeTable(''), null);
});

test('parsePipeTable returns null for insufficient lines', () => {
  assert.equal(parsePipeTable('| Header |'), null);
});

// ─── Content-aware rendering ────────────────────────────────────────────────

test('renderContentAwareTable produces columnar output with headers and data', () => {
  const headers = ['File', 'Status'];
  const rows = [{ cells: ['src/main.ts', 'PASS'] }, { cells: ['src/utils.ts', 'FAIL'] }];

  const output = renderContentAwareTable(headers, rows);
  assert.ok(output.includes('File'));
  assert.ok(output.includes('Status'));
  assert.ok(output.includes('main.ts'));
  assert.ok(output.includes('PASS'));
});

test('renderContentAwareTable returns empty string for empty input', () => {
  assert.equal(renderContentAwareTable([], []), '');
  assert.equal(renderContentAwareTable(['Col'], []), '');
});

test('renderContentAwareTable handles single row tables', () => {
  const headers = ['Key', 'Value'];
  const rows = [{ cells: ['Version', '1.0.0'] }];

  const output = renderContentAwareTable(headers, rows);
  assert.ok(output.includes('Version'));
  assert.ok(output.includes('1.0.0'));
});

test('renderContentAwareTable handles multi-column tables', () => {
  const headers = ['Name', 'Status', 'Duration', 'Memory'];
  const rows = [
    { cells: ['test-a', 'PASS', '1.2s', '45MB'] },
    { cells: ['test-b', 'FAIL', '3.1s', '72MB'] },
  ];

  const output = renderContentAwareTable(headers, rows);
  assert.ok(output.includes('test-a'));
  assert.ok(output.includes('test-b'));
  assert.ok(output.includes('PASS'));
  assert.ok(output.includes('FAIL'));
});

test('renderContentAwareTable handles empty cells', () => {
  const headers = ['Name', 'Value'];
  const rows = [{ cells: ['key', ''] }];

  const output = renderContentAwareTable(headers, rows);
  assert.ok(output.includes('key'));
});

test('renderContentAwareTable includes content from all cells', () => {
  const headers = ['A', 'B', 'C'];
  const rows = [{ cells: ['1', '2', '3'] }];

  const output = renderContentAwareTable(headers, rows);
  assert.ok(output.includes('1'));
  assert.ok(output.includes('2'));
  assert.ok(output.includes('3'));
});
