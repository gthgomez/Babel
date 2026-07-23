/**
 * moduleSelector.test.ts — Tests for the deterministic OLS-MCC module selector
 *
 * Verifies that all 5 v4.5 archetypes map to the expected optimizer, depth,
 * and gating strategy per the decision guidance table.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectModules,
  validateArchetypes,
  formatModuleSelectionHuman,
  formatArchetypeTable,
  depthMax,
  ARCHETYPES,
  type TaskProfile,
} from './moduleSelector.js';

// ─── Depth mode utility ────────────────────────────────────────────────────────

test('depthMax — returns deeper mode', () => {
  assert.equal(depthMax('LIGHT', 'STANDARD'), 'STANDARD');
  assert.equal(depthMax('STANDARD', 'DEEP'), 'DEEP');
  assert.equal(depthMax('DEEP', 'PRODUCTION'), 'PRODUCTION');
  assert.equal(depthMax('LIGHT', 'PRODUCTION'), 'PRODUCTION');
  assert.equal(depthMax('STANDARD', 'STANDARD'), 'STANDARD');
});

// ─── Archetype validation against v4.5 spec ────────────────────────────────────

test('selectModules — self-improving meta → reflection + PRODUCTION + multi', () => {
  const sel = selectModules(ARCHETYPES.selfImprovingMeta!);
  assert.equal(sel.optimizerType, 'reflection');
  assert.equal(sel.depthMode, 'PRODUCTION');
  assert.equal(sel.gating, 'multi');
});

test('selectModules — complex multi-agent → reflection + DEEP + multi', () => {
  const sel = selectModules(ARCHETYPES.complexMultiAgent!);
  assert.equal(sel.optimizerType, 'reflection');
  assert.equal(sel.depthMode, 'DEEP');
  assert.equal(sel.gating, 'multi');
});

test('selectModules — conversational compliance → promptomatix + DEEP + multi', () => {
  const sel = selectModules(ARCHETYPES.conversationalCompliance!);
  assert.equal(sel.optimizerType, 'promptomatix');
  assert.equal(sel.depthMode, 'DEEP'); // safety constraints force DEEP
  assert.equal(sel.gating, 'multi');
});

test('selectModules — high-frequency reusable → SPO + DEEP + single', () => {
  const sel = selectModules(ARCHETYPES.highFrequencyReusable!);
  assert.equal(sel.optimizerType, 'SPO');
  assert.equal(sel.depthMode, 'DEEP');
  assert.equal(sel.gating, 'single'); // DEEP but not PRODUCTION → single
});

test('selectModules — simple one-off → none + STANDARD + single', () => {
  const sel = selectModules(ARCHETYPES.simpleOneOff!);
  assert.equal(sel.optimizerType, 'none');
  assert.equal(sel.depthMode, 'STANDARD');
  assert.equal(sel.gating, 'single');
});

// ─── Default / ambiguous ──────────────────────────────────────────────────────

test('selectModules — empty profile → none + STANDARD + single', () => {
  const sel = selectModules({
    isHighFrequency: false,
    isConversational: false,
    isMultiAgent: false,
    isSelfImproving: false,
    isSimpleOneOff: false,
    hasSafetyConstraints: false,
    hasStateManagement: false,
  });
  assert.equal(sel.optimizerType, 'none');
  assert.equal(sel.depthMode, 'STANDARD');
  assert.equal(sel.gating, 'single');
});

// ─── User depth override ──────────────────────────────────────────────────────

test('selectModules — user depth overrides inference', () => {
  const sel = selectModules({
    ...ARCHETYPES.simpleOneOff!,
    userRequestedDepth: 'PRODUCTION',
  });
  assert.equal(sel.depthMode, 'PRODUCTION');
  assert.ok(sel.depthOverridden);
});

// ─── Safety constraints ───────────────────────────────────────────────────────

test('selectModules — safety constraints upgrade depth', () => {
  // A conversational task WITHOUT safety constraints should get STANDARD
  const conversationalProfile: TaskProfile = {
    isHighFrequency: false,
    isConversational: true,
    isMultiAgent: false,
    isSelfImproving: false,
    isSimpleOneOff: false,
    hasSafetyConstraints: false,
    hasStateManagement: false,
  };
  const withoutSafety = selectModules(conversationalProfile);
  assert.equal(withoutSafety.depthMode, 'STANDARD');

  // Same task WITH safety constraints should get DEEP
  const withSafety = selectModules({
    ...conversationalProfile,
    hasSafetyConstraints: true,
  });
  // Re-classify: now conversational + safety → DEEP
  assert.equal(withSafety.depthMode, 'DEEP');
});

// ─── All archetypes produce valid selections ──────────────────────────────────

test('validateArchetypes — all 5 return valid selections', () => {
  const results = validateArchetypes();
  assert.equal(results.size, 5);
  for (const [name, sel] of results) {
    assert.ok(['SPO', 'promptomatix', 'reflection', 'none'].includes(sel.optimizerType),
      `${name}: invalid optimizerType ${sel.optimizerType}`);
    assert.ok(['LIGHT', 'STANDARD', 'DEEP', 'PRODUCTION'].includes(sel.depthMode),
      `${name}: invalid depthMode ${sel.depthMode}`);
    assert.ok(['single', 'multi'].includes(sel.gating),
      `${name}: invalid gating ${sel.gating}`);
    assert.ok(sel.explanation.length > 0, `${name}: missing explanation`);
  }
});

// ─── Human-readable formatters ────────────────────────────────────────────────

test('formatModuleSelectionHuman — produces expected sections', () => {
  const profile = ARCHETYPES.highFrequencyReusable!;
  const sel = selectModules(profile);
  const formatted = formatModuleSelectionHuman(profile, sel);
  assert.ok(formatted.includes('OLS-MCC Module Selection'));
  assert.ok(formatted.includes('Optimizer:'));
  assert.ok(formatted.includes('SPO'));
});

test('formatArchetypeTable — includes all 5 archetypes', () => {
  const table = formatArchetypeTable();
  assert.ok(table.includes('highFrequencyReusable'));
  assert.ok(table.includes('conversationalCompliance'));
  assert.ok(table.includes('complexMultiAgent'));
  assert.ok(table.includes('selfImprovingMeta'));
  assert.ok(table.includes('simpleOneOff'));
});
