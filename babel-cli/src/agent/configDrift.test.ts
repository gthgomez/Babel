import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeConfigBaselineHashes,
  DEFAULT_CONFIG_DRIFT_PATHS,
  detectConfigDrift,
} from './verifierIntegrity.js';

function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-config-drift-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

test('config drift: baseline captures present files only', () => {
  const root = tempProject({ 'config/model-policy.json': '{"stages":{}}' });
  try {
    const baseline = computeConfigBaselineHashes(root);
    assert.ok(baseline['config/model-policy.json']);
    assert.equal(baseline['.babel/task-envelope.json'], undefined, 'missing files have no baseline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config drift: unchanged config is not drift', () => {
  const root = tempProject({ 'config/model-policy.json': '{"stages":{}}' });
  try {
    const baseline = computeConfigBaselineHashes(root);
    const current = computeConfigBaselineHashes(root);
    assert.equal(detectConfigDrift(baseline, current), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config drift: mutated config is drift', () => {
  const root = tempProject({ 'config/model-policy.json': '{"stages":{}}' });
  try {
    const baseline = computeConfigBaselineHashes(root);
    writeFileSync(join(root, 'config', 'model-policy.json'), '{"stages":{"orchestrator":[]}}', 'utf-8');
    const current = computeConfigBaselineHashes(root);
    assert.equal(detectConfigDrift(baseline, current), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config drift: deleted config is drift', () => {
  const root = tempProject({ 'config/model-policy.json': '{"stages":{}}' });
  try {
    const baseline = computeConfigBaselineHashes(root);
    rmSync(join(root, 'config', 'model-policy.json'));
    const current = computeConfigBaselineHashes(root);
    assert.equal(detectConfigDrift(baseline, current), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config drift: empty baseline never reports drift', () => {
  const root = tempProject({});
  try {
    const baseline = computeConfigBaselineHashes(root);
    const current = computeConfigBaselineHashes(root);
    assert.equal(detectConfigDrift(baseline, current), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config drift: default path list is explicit and bounded', () => {
  // The default list must not grow into everything-but-the-kitchen-sink;
  // extend it deliberately, never by accident.
  assert.ok(DEFAULT_CONFIG_DRIFT_PATHS.includes('config/model-policy.json'));
  assert.ok(DEFAULT_CONFIG_DRIFT_PATHS.length <= 4);
});
