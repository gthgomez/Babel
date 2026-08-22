/**
 * controlPlaneResolution.test.ts — public-mode stack-resolution contract.
 *
 * Pins the canonical Chat / Plan / Deep resolution semantics against the
 * REAL repository catalog (prompt_catalog.yaml), so resolver behavior
 * cannot drift silently inside a docs-only-looking change:
 *
 *   1. behavioral `always_load` tagging selects the Behavioral OS layer
 *   2. chat resolves with NO execution pipeline stages
 *   3. plan resolves review-only pipeline (QA reviewer, no executor)
 *   4. deep resolves QA reviewer + CLI executor
 *   5. model_adapter loads before task_overlay (layer ordering)
 *   6. codex adapter aliases collapse onto adapter_codex
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  resolveLocalStack,
  type LocalPipelineMode,
} from './control-plane/localStackResolver.js';

const CLI_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BABEL_ROOT = resolve(CLI_ROOT, '..');

function resolveStack(pipelineMode: LocalPipelineMode) {
  return resolveLocalStack({
    taskCategory: 'backend',
    project: 'example_saas_backend',
    model: 'codex',
    pipelineMode,
    babelRoot: BABEL_ROOT,
  });
}

const stackIds = (stack: { Id: string }[]) => stack.map((entry) => entry.Id);

test('behavioral always_load tagging selects the Behavioral OS layer', () => {
  const result = resolveStack('chat');
  const ids = stackIds(result.SelectedStack);
  assert.ok(
    ids.includes('behavioral_core_v11'),
    `always_load behavioral layer must be tag-selected, got: ${ids.join(', ')}`,
  );
});

test('chat resolves with no execution pipeline stages', () => {
  const result = resolveStack('chat');
  const pipeline = result.SelectedStack.filter((e) => e.Layer === 'pipeline_stage');
  assert.deepEqual(
    stackIds(pipeline),
    [],
    'chat is the default daily experience and must not attach execution pipelines',
  );
});

test('plan resolves review-only pipeline (QA reviewer, no executor)', () => {
  const result = resolveStack('plan');
  const pipeline = stackIds(
    result.SelectedStack.filter((e) => e.Layer === 'pipeline_stage'),
  );
  assert.deepEqual(
    pipeline.sort(),
    ['pipeline_qa_reviewer'],
    'plan must attach exactly the QA reviewer stage',
  );
});

test('deep resolves QA reviewer + CLI executor', () => {
  const result = resolveStack('deep');
  const pipeline = stackIds(
    result.SelectedStack.filter((e) => e.Layer === 'pipeline_stage'),
  );
  assert.deepEqual(
    pipeline.sort(),
    ['pipeline_cli_executor', 'pipeline_qa_reviewer'],
    'deep must attach QA review plus governed execution',
  );
});

test('model_adapter loads before task_overlay in emission order', () => {
  const result = resolveStack('deep');
  const layers = result.SelectedStack.map((e) => e.Layer);
  const adapterIndex = layers.indexOf('model_adapter');
  assert.ok(adapterIndex >= 0, 'deep stack must include a model adapter');
  const overlayIndex = layers.indexOf('task_overlay');
  if (overlayIndex >= 0) {
    assert.ok(
      adapterIndex < overlayIndex,
      `model_adapter (index ${adapterIndex}) must load before task_overlay (index ${overlayIndex})`,
    );
  }
});

test('codex adapter selection collapses onto adapter_codex', () => {
  const result = resolveLocalStack({
    taskCategory: 'frontend',
    project: 'global',
    model: 'codex',
    pipelineMode: 'chat',
    babelRoot: BABEL_ROOT,
  });
  const adapters = stackIds(
    result.SelectedStack.filter((e) => e.Layer === 'model_adapter'),
  );
  assert.deepEqual(
    adapters,
    ['adapter_codex'],
    "model 'codex' must resolve the canonical codex adapter",
  );
});

test('legacy codex adapter alias balanced maps onto adapter_codex', () => {
  // The catalog ships one codex adapter; legacy tier names must alias onto
  // it rather than resolving a nonexistent id.
  const result = resolveLocalStack({
    taskCategory: 'frontend',
    project: 'global',
    model: 'codex',
    codexAdapter: 'balanced',
    pipelineMode: 'chat',
    babelRoot: BABEL_ROOT,
  });
  assert.equal(result.SelectedCodexAdapter, 'balanced');
  const adapters = stackIds(
    result.SelectedStack.filter((e) => e.Layer === 'model_adapter'),
  );
  assert.deepEqual(
    adapters,
    ['adapter_codex'],
    'legacy balanced tier must alias onto the canonical adapter_codex entry',
  );
});
