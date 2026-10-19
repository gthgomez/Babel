import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconcileReplayCellsForPersist } from './commandCodeAcpRuntime.js';
import type { HistoryCellRecord } from '../ui/historyCells/types.js';

function assistantCell(id: string, message: string, revision = 1): HistoryCellRecord {
  return {
    schema_version: 1,
    cell_id: id,
    thread_id: 'thread-1',
    kind: 'assistant_message',
    lifecycle: 'committed',
    revision,
    ts: '1',
    payload: { message },
  };
}

describe('reconcileReplayCellsForPersist', () => {
  it('appends only novel cell ids', () => {
    const existing = [assistantCell('a', 'old')];
    const incoming = [assistantCell('a', 'old'), assistantCell('b', 'new')];
    const result = reconcileReplayCellsForPersist(existing, incoming);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.cell_id, 'b');
  });

  it('appends bumped revision when payload changes for an existing id', () => {
    const existing = [assistantCell('a', 'stale', 1)];
    const incoming = [assistantCell('a', 'fresh', 1)];
    const result = reconcileReplayCellsForPersist(existing, incoming);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.revision, 2);
    assert.equal((result[0]?.payload as { message: string }).message, 'fresh');
  });
});

describe('collapseHistoryCellsById', () => {
  it('returns the latest revision per cell id in stable order', async () => {
    const { collapseHistoryCellsById } = await import('../services/threadStore/threadStore.js');
    const cells = [
      assistantCell('a', 'stale', 1),
      assistantCell('b', 'only', 1),
      assistantCell('a', 'fresh', 2),
    ];
    const collapsed = collapseHistoryCellsById(cells);
    assert.equal(collapsed.length, 2);
    assert.equal((collapsed[0]?.payload as { message: string }).message, 'fresh');
    assert.equal((collapsed[1]?.payload as { message: string }).message, 'only');
  });
});
