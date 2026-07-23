// ─── Phase Model Routing Tests ────────────────────────────────────────────────
// Offline unit tests for resolvePhaseModelName — no live API, no engine needed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolvePhaseModelName } from './phaseModelRouting.js';

describe('resolvePhaseModelName', () => {
  describe('both models configured', () => {
    const limits = {
      investigateModel: 'flash-model',
      mutateModel: 'pro-model',
    };

    it('returns investigateModel when phase is null (first turn)', () => {
      assert.equal(resolvePhaseModelName(null, limits), 'flash-model');
    });

    it('returns investigateModel when phase is investigate', () => {
      assert.equal(resolvePhaseModelName('investigate', limits), 'flash-model');
    });

    it('returns mutateModel when phase is mutate', () => {
      assert.equal(resolvePhaseModelName('mutate', limits), 'pro-model');
    });

    it('returns mutateModel when phase is verify', () => {
      assert.equal(resolvePhaseModelName('verify', limits), 'pro-model');
    });

    it('returns mutateModel when phase is escalate', () => {
      assert.equal(resolvePhaseModelName('escalate', limits), 'pro-model');
    });
  });

  describe('only investigateModel configured', () => {
    const limits = { investigateModel: 'flash-model' };

    it('returns investigateModel for investigate phase', () => {
      assert.equal(resolvePhaseModelName('investigate', limits), 'flash-model');
    });

    it('returns investigateModel for null phase', () => {
      assert.equal(resolvePhaseModelName(null, limits), 'flash-model');
    });

    it('returns undefined for mutate phase (no mutate model set)', () => {
      assert.equal(resolvePhaseModelName('mutate', limits), undefined);
    });

    it('returns undefined for verify phase', () => {
      assert.equal(resolvePhaseModelName('verify', limits), undefined);
    });
  });

  describe('only mutateModel configured', () => {
    const limits = { mutateModel: 'pro-model' };

    it('returns undefined for investigate phase (no investigate model set)', () => {
      assert.equal(resolvePhaseModelName('investigate', limits), undefined);
    });

    it('returns undefined for null phase (no investigate model set)', () => {
      assert.equal(resolvePhaseModelName(null, limits), undefined);
    });

    it('returns mutateModel for mutate phase', () => {
      assert.equal(resolvePhaseModelName('mutate', limits), 'pro-model');
    });

    it('returns mutateModel for verify phase', () => {
      assert.equal(resolvePhaseModelName('verify', limits), 'pro-model');
    });
  });

  describe('no phase models configured', () => {
    it('returns undefined for all phases (fallback to primary)', () => {
      assert.equal(resolvePhaseModelName(null, {}), undefined);
      assert.equal(resolvePhaseModelName('investigate', {}), undefined);
      assert.equal(resolvePhaseModelName('mutate', {}), undefined);
      assert.equal(resolvePhaseModelName('verify', {}), undefined);
      assert.equal(resolvePhaseModelName('escalate', {}), undefined);
    });
  });

  describe('undefined values treated as unset', () => {
    it('investigateModel=undefined does not match', () => {
      const limits: { investigateModel?: string | undefined; mutateModel?: string | undefined } = {
        mutateModel: 'pro-model',
      };
      limits.investigateModel = undefined;
      const result = resolvePhaseModelName('investigate', limits);
      assert.equal(result, undefined);
    });

    it('mutateModel=undefined does not match', () => {
      const limits: { investigateModel?: string | undefined; mutateModel?: string | undefined } = {
        investigateModel: 'flash-model',
      };
      limits.mutateModel = undefined;
      const result = resolvePhaseModelName('mutate', limits);
      assert.equal(result, undefined);
    });
  });
});

describe('TurnRoutingReceipt model field parity', () => {
  // These tests verify that the resolvePhaseModelName return value maps to
  // the model field that would appear in a TurnRoutingReceipt.
  //
  // When resolvePhaseModelName returns a model name, the chatEngine should
  // route the turn through that model, and pushRoutingReceiptFromMetadata
  // records it as receipt.model. When it returns undefined, the primary
  // deliberation model is used and recorded.

  it('phase investigate → receipt model matches investigateModel', () => {
    const limits = {
      investigateModel: 'flash-investigate',
      mutateModel: 'pro-mutate',
    };

    // Phase investigate → model = investigateModel
    const resolved = resolvePhaseModelName('investigate', limits);
    assert.equal(resolved, 'flash-investigate');

    // This resolved name would appear as receipt.model in the TurnRoutingReceipt
  });

  it('phase verify → receipt model matches mutateModel', () => {
    const limits = {
      investigateModel: 'flash-investigate',
      mutateModel: 'pro-mutate',
    };

    // Phase verify → model = mutateModel
    const resolved = resolvePhaseModelName('verify', limits);
    assert.equal(resolved, 'pro-mutate');

    // This resolved name would appear as receipt.model in the TurnRoutingReceipt
  });

  it('no phase models → receipt model is primary (undefined from resolver)', () => {
    const resolved = resolvePhaseModelName('mutate', {});
    assert.equal(resolved, undefined);
    // When undefined, chatEngine uses the primary deliberation model,
    // and receipt.model records the primary model name.
  });
});
