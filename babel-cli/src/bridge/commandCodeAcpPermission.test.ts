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
    assert.match(JSON.stringify(edit), /a\.txt/);
    assert.match(JSON.stringify(del), /b\.txt/);
  });
});
