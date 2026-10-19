import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { permissionActionFromAcpParams, selectAllowOnceOptionId } from './openCodeAcpPermission.js';

describe('openCodeAcpPermission', () => {
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
          rawInput: { path: 'a.txt', content: '' },
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
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'edit a.txt',
          toolCall: { toolCallId: 'tc_same', kind: 'edit', rawInput: { path: 'a.txt' } },
        },
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

  it('binds ACP diff previews in toolCall.content separately from empty rawInput', () => {
    const safe = permissionActionFromAcpParams(
      {
        title: 'edit a.txt',
        toolCall: {
          kind: 'edit',
          rawInput: { path: 'a.txt' },
          content: [{ type: 'diff', path: 'a.txt', oldText: '', newText: 'SAFE' }],
        },
      },
      '/proj',
    );
    const evil = permissionActionFromAcpParams(
      {
        title: 'edit a.txt',
        toolCall: {
          kind: 'edit',
          rawInput: { path: 'a.txt' },
          content: [{ type: 'diff', path: 'a.txt', oldText: '', newText: 'EVIL' }],
        },
      },
      '/proj',
    );
    assert.notDeepEqual(safe, evil);
    if (safe?.type !== 'ask_approval' || evil?.type !== 'ask_approval') throw new Error('expected approvals');
    const safeDigest = safe.reason.match(/sha256=([a-f0-9]+)/)?.[1];
    const evilDigest = evil.reason.match(/sha256=([a-f0-9]+)/)?.[1];
    assert.ok(safeDigest && evilDigest);
    assert.notEqual(safeDigest, evilDigest);
    assert.equal(
      createHash('sha256').update('diff:a.txt\n---OLD---\n\n---NEW---\nSAFE').digest('hex'),
      safeDigest,
    );
  });

  it('binds multi-file diff previews in stable order', () => {
    const multi = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'edit',
          content: [
            { type: 'diff', path: 'b.txt', oldText: 'b', newText: 'B' },
            { type: 'diff', path: 'a.txt', oldText: 'a', newText: 'A' },
          ],
        },
      },
      '/proj',
    );
    assert.equal(multi?.type, 'ask_approval');
    if (multi?.type !== 'ask_approval') return;
    const digest = multi.reason.match(/sha256=([a-f0-9]+)/)?.[1];
    const material = [
      'diff:a.txt\n---OLD---\na\n---NEW---\nA',
      'diff:b.txt\n---OLD---\nb\n---NEW---\nB',
    ].join('\n===\n');
    assert.equal(createHash('sha256').update(material).digest('hex'), digest);
  });
});
