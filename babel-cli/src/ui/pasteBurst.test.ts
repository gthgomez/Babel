import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PasteBurst,
  PASTE_ENTER_SUPPRESS_WINDOW_MS,
} from './pasteBurst.js';

describe('PasteBurst', () => {
  it('ascii first char is held then flushes as typed', () => {
    const burst = new PasteBurst();
    const t0 = 1000;
    assert.equal(burst.onPlainChar('a', t0).type, 'retainFirstChar');

    const t1 = t0 + PasteBurst.recommendedFlushDelayMs() + 1;
    const flush = burst.flushIfDue(t1);
    assert.equal(flush.type, 'typed');
    if (flush.type === 'typed') assert.equal(flush.char, 'a');
    assert.equal(burst.isActive(), false);
  });

  it('ascii two fast chars start buffer from pending and flush as paste', () => {
    const burst = new PasteBurst();
    const t0 = 1000;
    assert.equal(burst.onPlainChar('a', t0).type, 'retainFirstChar');

    const t1 = t0 + 1;
    assert.equal(burst.onPlainChar('b', t1).type, 'beginBufferFromPending');
    burst.appendCharToBuffer('b', t1);

    const t2 = t1 + PasteBurst.recommendedActiveFlushDelayMs() + 1;
    const flush = burst.flushIfDue(t2);
    assert.equal(flush.type, 'paste');
    if (flush.type === 'paste') assert.equal(flush.text, 'ab');
  });

  it('flush before modified input includes pending first char', () => {
    const burst = new PasteBurst();
    const t0 = 1000;
    assert.equal(burst.onPlainChar('a', t0).type, 'retainFirstChar');
    assert.equal(burst.flushBeforeModifiedInput(), 'a');
    assert.equal(burst.isActive(), false);
  });

  it('decide begin buffer only triggers for pastey prefixes', () => {
    const burst = new PasteBurst();
    const now = 1000;

    assert.equal(burst.decideBeginBuffer(now, 'ab', 2), null);
    assert.equal(burst.isActive(), false);

    const grab = burst.decideBeginBuffer(now, 'a b', 2);
    assert.ok(grab);
    assert.equal(grab!.startByte, 1);
    assert.equal(grab!.grabbed, ' b');
    assert.equal(burst.isActive(), true);
  });

  it('newline suppression window outlives buffer flush', () => {
    const burst = new PasteBurst();
    const t0 = 1000;
    assert.equal(burst.onPlainChar('a', t0).type, 'retainFirstChar');

    const t1 = t0 + 1;
    assert.equal(burst.onPlainChar('b', t1).type, 'beginBufferFromPending');
    burst.appendCharToBuffer('b', t1);

    const t2 = t1 + PasteBurst.recommendedActiveFlushDelayMs() + 1;
    const flush = burst.flushIfDue(t2);
    assert.equal(flush.type, 'paste');
    if (flush.type === 'paste') assert.equal(flush.text, 'ab');
    assert.equal(burst.isActive(), false);

    assert.equal(burst.newlineShouldInsertInsteadOfSubmit(t2), true);
    const t3 = t1 + PASTE_ENTER_SUPPRESS_WINDOW_MS + 1;
    assert.equal(burst.newlineShouldInsertInsteadOfSubmit(t3), false);
  });
});