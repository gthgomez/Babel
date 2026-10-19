import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { permissionActionFromAcpParams, selectAllowOnceOptionId } from './commandCodeAcpPermission.js';

describe('commandCodeAcpPermission', () => {
  it('selects allow_once only and rejects allow_always fallback', () => {
    const options = [
      { optionId: 'persistent_allow', kind: 'allow_always', name: 'Always' },
      { optionId: 'once', kind: 'allow_once', name: 'Once' },
    ];
    assert.equal(selectAllowOnceOptionId(options), 'once');
    assert.equal(selectAllowOnceOptionId([options[0]]), null);
  });

  it('binds distinct structured tool operations from v1 rawInput', () => {
    const edit = permissionActionFromAcpParams(
      {
        title: 'edit a.txt',
        toolCall: {
          toolCallId: 'tc_edit',
          kind: 'edit',
          rawInput: { path: 'a.txt' },
        },
      },
      '/proj',
    );
    const del = permissionActionFromAcpParams(
      {
        title: 'delete b.txt',
        toolCall: {
          toolCallId: 'tc_del',
          kind: 'delete',
          rawInput: { path: 'b.txt' },
        },
      },
      '/proj',
    );
    assert.notDeepEqual(edit, del);
    assert.equal(edit?.type, 'ask_approval');
    assert.equal(del?.type, 'ask_approval');
    if (edit?.type !== 'ask_approval' || del?.type !== 'ask_approval') throw new Error('expected ask_approval');
    assert.equal(edit.requested_action.type, 'run_command');
    assert.equal(del.requested_action.type, 'run_command');
    assert.match(edit.requested_action.command, /acp:edit:a\.txt/);
    assert.match(del.requested_action.command, /acp:delete:b\.txt/);
    const read = permissionActionFromAcpParams(
      {
        title: 'read c.txt',
        toolCall: { toolCallId: 'tc_read', kind: 'read', rawInput: { path: 'c.txt' } },
      },
      '/proj',
    );
    assert.equal(read?.type, 'ask_approval');
    if (read?.type === 'ask_approval') assert.equal(read.requested_action.type, 'read_file');
    assert.equal(
      permissionActionFromAcpParams({ title: 'mystery', toolCall: { kind: 'warp' } }, '/proj'),
      null,
    );
    assert.equal(
      permissionActionFromAcpParams(
        { title: 'mystery', subject: { path: 'secret.txt' }, toolCall: { kind: 'warp' } },
        '/proj',
      ),
      null,
    );
    const safe = permissionActionFromAcpParams(
      {
        title: 'edit a.txt',
        toolCall: { toolCallId: 'tc_same', kind: 'edit', rawInput: { path: 'a.txt', content: 'SAFE' } },
      },
      '/proj',
    );
    const evil = permissionActionFromAcpParams(
      {
        title: 'edit a.txt',
        toolCall: { toolCallId: 'tc_same', kind: 'edit', rawInput: { path: 'a.txt', content: 'EVIL' } },
      },
      '/proj',
    );
    assert.notDeepEqual(safe, evil);
  });
});
