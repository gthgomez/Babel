import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WsTicketStore } from './wsTicket.js';

describe('WsTicketStore', () => {
  it('accepts a fresh ticket and rejects missing, bad, expired, replayed, and scope-mismatched tickets', () => {
    const store = new WsTicketStore(1_000);
    const now = 1_000_000;
    const minted = store.mint({ sessionId: 'sess-a', threadId: 'thr-a', now });
    assert.ok(minted.ticket.length > 16);
    assert.equal(minted.session_id, 'sess-a');

    assert.equal(store.consume({ ticket: undefined, sessionId: 'sess-a', now }).ok, false);
    assert.equal(store.consume({ ticket: 'not-a-ticket', sessionId: 'sess-a', now }).ok, false);

    const expired = store.consume({
      ticket: minted.ticket,
      sessionId: 'sess-a',
      now: now + 5_000,
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.error, 'expired');

    const fresh = store.mint({ sessionId: 'sess-a', threadId: 'thr-a', now });
    const mismatch = store.consume({
      ticket: fresh.ticket,
      sessionId: 'sess-b',
      now,
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error, 'scope_mismatch');

    const threadMismatch = store.consume({
      ticket: fresh.ticket,
      sessionId: 'sess-a',
      threadId: 'thr-other',
      now,
    });
    assert.equal(threadMismatch.ok, false);
    if (!threadMismatch.ok) assert.equal(threadMismatch.error, 'scope_mismatch');

    const ok = store.consume({ ticket: fresh.ticket, sessionId: 'sess-a', now });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.threadId, 'thr-a');

    const replay = store.consume({ ticket: fresh.ticket, sessionId: 'sess-a', now });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.error, 'replayed');
  });
});
