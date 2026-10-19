import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TurnTerminalRecord } from '../protocol/types.js';
import { reconcileTerminalTurnFromHost } from './sharedProtocolHostRun.js';

class MockProtocolClient {
  constructor(
    private readonly catalog: { status: string; active_turn: boolean },
    private readonly turnTerminal: TurnTerminalRecord | null,
    private readonly hasMachineEvidence = false,
  ) {}

  async call<M extends string, _P, R>(method: M): Promise<R> {
    if (method === 'remote.catalog') {
      return {
        sessions: [{ thread_id: 'thr-1', status: this.catalog.status, active_turn: this.catalog.active_turn }],
      } as R;
    }
    if (method === 'history.lookup') {
      return {
        cells: [],
        turn_terminal: this.turnTerminal,
      } as R;
    }
    if (method === 'verification.lookup') {
      return { has_machine_evidence: this.hasMachineEvidence } as R;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

describe('reconcileTerminalTurnFromHost provenance', () => {
  it('returns null when idle catalog has no persisted terminal for the submitted turn', async () => {
    const client = new MockProtocolClient(
      { status: 'idle', active_turn: false },
      null,
    ) as never;
    const result = await reconcileTerminalTurnFromHost(client, 'thr-1', 9);
    assert.equal(result, null);
  });

  it('never fabricates VERIFIED_COMPLETE without machine evidence', async () => {
    const client = new MockProtocolClient(
      { status: 'idle', active_turn: false },
      {
        turn_id: 9,
        event_type: 'done',
        answer: '',
        outcome: 'VERIFIED_COMPLETE',
        recorded_at: new Date().toISOString(),
      },
      false,
    ) as never;
    const result = await reconcileTerminalTurnFromHost(client, 'thr-1', 9) as {
      result?: { terminal_outcome?: string };
    };
    assert.equal(result?.result?.terminal_outcome, 'UNVERIFIED_PATCH');
  });

  it('preserves fixture execution as unverified patch', async () => {
    const client = new MockProtocolClient(
      { status: 'idle', active_turn: false },
      {
        turn_id: 3,
        event_type: 'done',
        answer: 'ok',
        outcome: 'VERIFIED_COMPLETE',
        fixture_execution: true,
        fixture_kind: 'acceptance-deterministic-bridge-v1',
        recorded_at: new Date().toISOString(),
      },
      true,
    ) as never;
    const result = await reconcileTerminalTurnFromHost(client, 'thr-1', 3) as {
      result?: { terminal_outcome?: string; fixture_execution?: boolean };
    };
    assert.equal(result?.result?.terminal_outcome, 'UNVERIFIED_PATCH');
    assert.equal(result?.result?.fixture_execution, true);
  });
});
