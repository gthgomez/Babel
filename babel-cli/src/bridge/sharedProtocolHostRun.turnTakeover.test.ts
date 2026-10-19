import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HistoryLookupResult } from '../protocol/types.js';
import { reconcileTerminalTurnFromHost } from './sharedProtocolHostRun.js';

class TakeoverCatalogClient {
  async call<M extends string, _P, R>(_method: M, _params: unknown): Promise<R> {
    if (_method === 'remote.catalog') {
      return {
        host: { execution_owner: 'protocol_host', registered_workspace_root: '/tmp' },
        workspaces: [],
        sessions: [
          {
            thread_id: 'thr-1',
            project_root: '/tmp',
            mode: 'chat',
            status: 'running',
            preview: '',
            updated_at: 1,
            active_turn: true,
            active_turn_id: 2,
          },
        ],
      } as R;
    }
    if (_method === 'history.lookup') {
      return {
        cells: [],
        has_more: false,
        turn_terminal: {
          turn_id: 1,
          event_type: 'done',
          answer: 'turn one',
          fixture_execution: true,
          recorded_at: 't',
        },
      } as HistoryLookupResult as R;
    }
    if (_method === 'verification.lookup') {
      return { has_machine_evidence: false } as R;
    }
    throw new Error(`unexpected ${_method}`);
  }
}

describe('sharedProtocolHostRun turn takeover reconciliation', () => {
  it('reconciles settled turn N while turn N+1 is active on the same thread', async () => {
    const stream = await reconcileTerminalTurnFromHost(
      new TakeoverCatalogClient() as never,
      'thr-1',
      1,
    );
    assert.ok(stream);
    assert.equal(stream?.type, 'run_complete');
    const result = (stream as { result?: { terminal_outcome?: string } }).result;
    assert.equal(result?.terminal_outcome, 'UNVERIFIED_PATCH');
  });
});
