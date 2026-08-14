import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRequestReconstructionInvariant,
  MODEL_VISIBLE_EQUALS_PERSISTED,
  RuntimeInvariantRegistry,
  RuntimeInvariantViolationError,
  resolveRuntimeInvariantMode,
  type RequestReconstructionContext,
} from './runtimeInvariants.js';

const matching: RequestReconstructionContext = {
  outbound: [{ role: 'user', content: 'inspect hello.txt' }],
  reconstructed: [{ role: 'user', content: 'inspect hello.txt' }],
};

function registry(mode: 'enforce' | 'shadow'): RuntimeInvariantRegistry<RequestReconstructionContext> {
  const result = new RuntimeInvariantRegistry<RequestReconstructionContext>(mode);
  result.register(createRequestReconstructionInvariant());
  return result;
}

describe('RuntimeInvariantRegistry', () => {
  test('passes an equal model-visible request without recording a violation', () => {
    const subject = registry('enforce');
    assert.deepEqual(subject.evaluate(MODEL_VISIBLE_EQUALS_PERSISTED, matching), {
      invariantId: MODEL_VISIBLE_EQUALS_PERSISTED,
      passed: true,
    });
    assert.equal(subject.getViolationCount(MODEL_VISIBLE_EQUALS_PERSISTED), 0);
  });

  test('fails loud for an altered outgoing request in enforced mode', () => {
    const subject = registry('enforce');
    assert.throws(
      () => subject.evaluate(MODEL_VISIBLE_EQUALS_PERSISTED, {
        ...matching,
        outbound: [{ role: 'user', content: 'altered' }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeInvariantViolationError);
        assert.equal(error.violation.expectedShape[0]?.contentBytes, 'inspect hello.txt'.length);
        assert.equal(error.violation.actualShape[0]?.contentBytes, 'altered'.length);
        assert.notEqual(error.violation.expectedHash, error.violation.actualHash);
        return true;
      },
    );
    assert.equal(subject.getViolationCount(MODEL_VISIBLE_EQUALS_PERSISTED), 1);
  });

  test('reports and counts an altered outgoing request in shadow mode', () => {
    const subject = registry('shadow');
    const result = subject.evaluate(MODEL_VISIBLE_EQUALS_PERSISTED, {
      ...matching,
      outbound: [{ role: 'user', content: 'altered' }],
    });
    assert.equal(result.passed, false);
    assert.equal(result.violation?.invariantId, MODEL_VISIBLE_EQUALS_PERSISTED);
    assert.equal(subject.getViolationCount(MODEL_VISIBLE_EQUALS_PERSISTED), 1);
  });
});

test('resolves production to shadow and explicit modes deterministically', () => {
  const previousNodeEnv = process.env['NODE_ENV'];
  const previousCi = process.env['CI'];
  const previousMode = process.env['BABEL_RUNTIME_INVARIANTS'];
  try {
    process.env['NODE_ENV'] = 'production';
    delete process.env['CI'];
    delete process.env['BABEL_RUNTIME_INVARIANTS'];
    assert.equal(resolveRuntimeInvariantMode(), 'shadow');
    process.env['BABEL_RUNTIME_INVARIANTS'] = 'off';
    assert.equal(resolveRuntimeInvariantMode(), 'off');
    process.env['CI'] = 'true';
    delete process.env['BABEL_RUNTIME_INVARIANTS'];
    assert.equal(resolveRuntimeInvariantMode(), 'enforce');
    assert.equal(resolveRuntimeInvariantMode('shadow'), 'shadow');
  } finally {
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = previousNodeEnv;
    if (previousCi === undefined) delete process.env['CI']; else process.env['CI'] = previousCi;
    if (previousMode === undefined) delete process.env['BABEL_RUNTIME_INVARIANTS']; else process.env['BABEL_RUNTIME_INVARIANTS'] = previousMode;
  }
});