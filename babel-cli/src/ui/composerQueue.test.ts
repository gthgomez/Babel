import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComposerQueue,
  clearComposerQueue,
  drainComposerQueue,
  enqueueComposerMessage,
  getComposerQueueSnapshot,
} from './composerQueue.js';

describe('ComposerQueue', () => {
  it('enqueues and dequeues FIFO', () => {
    const q = new ComposerQueue();
    assert.equal(q.enqueue('first'), true);
    assert.equal(q.enqueue('second'), true);
    assert.equal(q.dequeue(), 'first');
    assert.equal(q.dequeue(), 'second');
    assert.equal(q.dequeue(), undefined);
  });

  it('rejects empty strings', () => {
    const q = new ComposerQueue();
    assert.equal(q.enqueue(''), false);
    assert.equal(q.enqueue('   '), false);
    assert.equal(q.length, 0);
  });

  it('caps at max depth', () => {
    const q = new ComposerQueue(2);
    assert.equal(q.enqueue('a'), true);
    assert.equal(q.enqueue('b'), true);
    assert.equal(q.enqueue('c'), false);
    assert.deepEqual(q.drain(), ['a', 'b']);
  });
});

describe('session composer queue', () => {
  it('exposes module-level FIFO helpers', () => {
    clearComposerQueue();
    assert.equal(enqueueComposerMessage('one'), true);
    assert.equal(enqueueComposerMessage('two'), true);
    assert.deepEqual(getComposerQueueSnapshot(), ['one', 'two']);
    assert.deepEqual(drainComposerQueue(), ['one', 'two']);
    assert.deepEqual(getComposerQueueSnapshot(), []);
  });
});