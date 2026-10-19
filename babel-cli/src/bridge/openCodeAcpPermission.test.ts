import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  effectiveShellExecution,
  permissionActionFromAcpParams,
  selectAllowOnceOptionId,
} from './openCodeAcpPermission.js';

describe('openCodeAcpPermission', () => {
  it('selects allow_once only and rejects allow_always fallback', () => {
    const options = [
      { optionId: 'persistent_allow', kind: 'allow_always', name: 'Always' },
      { optionId: 'once', kind: 'allow_once', name: 'Once' },
    ];
    assert.equal(selectAllowOnceOptionId(options), 'once');
    assert.equal(selectAllowOnceOptionId([options[0]]), null);
  });

  it('binds effective shell cwd/workdir separately from session cwd', () => {
    const a = permissionActionFromAcpParams(
      {
        title: 'shell',
        toolCall: {
          kind: 'execute',
          rawInput: { command: 'rm -rf output', cwd: '/project/a' },
        },
      },
      '/project',
    );
    const b = permissionActionFromAcpParams(
      {
        title: 'shell',
        toolCall: {
          kind: 'execute',
          rawInput: { command: 'rm -rf output', cwd: '/project/b' },
        },
      },
      '/project',
    );
    assert.notDeepEqual(a, b);
    if (a?.type !== 'ask_approval' || b?.type !== 'ask_approval') throw new Error('expected approvals');
    assert.equal(a.requested_action.type, 'run_command');
    assert.equal(b.requested_action.type, 'run_command');
    assert.equal(a.requested_action.cwd, '/project/a');
    assert.equal(b.requested_action.cwd, '/project/b');
    assert.equal(a.requested_action.command, 'rm -rf output');
  });

  it('resolves relative workdir against session cwd and accepts cmd alias', () => {
    const shell = effectiveShellExecution({ cmd: 'echo hi', workdir: 'child' }, '/project/root');
    assert.ok(shell);
    assert.equal(shell.command, 'echo hi');
    assert.match(shell.effectiveCwd, /\/project\/root\/child$/);
    const action = permissionActionFromAcpParams(
      { title: 'shell', toolCall: { kind: 'shell', rawInput: { cmd: 'echo hi', workdir: 'child' } } },
      '/project/root',
    );
    if (action?.type !== 'ask_approval') throw new Error('expected approval');
    if (action.requested_action.type !== 'run_command') throw new Error('expected run_command');
    assert.equal(action.requested_action.command, 'echo hi');
    assert.ok(action.requested_action.cwd);
    assert.match(action.requested_action.cwd, /\/project\/root\/child$/);
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
    const read = permissionActionFromAcpParams(
      {
        title: 'read c.txt',
        toolCall: { toolCallId: 'tc_read', kind: 'read', rawInput: { filePath: 'c.txt' } },
      },
      '/proj',
    );
    assert.equal(read?.type, 'ask_approval');
    if (read?.type === 'ask_approval') assert.equal(read.requested_action.type, 'read_file');
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
  });

  it('binds ACP diff previews with rawInput for edit operations', () => {
    const safe = permissionActionFromAcpParams(
      {
        title: 'edit a.txt',
        toolCall: {
          kind: 'edit',
          rawInput: { path: 'a.txt', content: 'SAFE' },
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
          rawInput: { path: 'a.txt', content: 'EVIL' },
          content: [{ type: 'diff', path: 'a.txt', oldText: '', newText: 'EVIL' }],
        },
      },
      '/proj',
    );
    assert.notDeepEqual(safe, evil);
  });

  it('distinguishes rename sources when previews match but patchText differs', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    const moveA = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'patch',
          rawInput: { patchText: '*** Begin Patch\n*** Update File: a\n*** End Patch' },
          content: preview,
        },
      },
      '/project',
    );
    const moveB = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'patch',
          rawInput: { patchText: '*** Begin Patch\n*** Update File: b\n*** End Patch' },
          content: preview,
        },
      },
      '/project',
    );
    assert.notDeepEqual(moveA, moveB);
    if (moveA?.type !== 'ask_approval' || moveB?.type !== 'ask_approval') throw new Error('expected approvals');
    assert.notEqual(
      moveA.reason.match(/sha256=([a-f0-9]+)/)?.[1],
      moveB.reason.match(/sha256=([a-f0-9]+)/)?.[1],
    );
  });

  it('binds multi-file diff previews with raw patch operation material', () => {
    const multi = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'patch',
          rawInput: { patchText: 'multi-file-patch' },
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
    if (multi.requested_action.type !== 'run_command') throw new Error('expected run_command');
    const digest = multi.reason.match(/sha256=([a-f0-9]+)/)?.[1];
    assert.ok(digest);
    assert.ok(multi.requested_action.command.includes('patchText'));
    assert.ok(multi.requested_action.command.includes('diff:a.txt'));
  });

  it('negative control: identical preview-only payloads without raw still fail closed for patch', () => {
    const previewOnly = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'patch',
          content: [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }],
        },
      },
      '/project',
    );
    assert.equal(previewOnly, null);
  });

  it('fail closed for vendor edit+name:patch with diff preview only (no rawInput)', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: { kind: 'edit', name: 'patch', content: preview },
        },
        '/project',
      ),
      null,
    );
  });

  it('fail closed for vendor edit+name:patch with empty rawInput object', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: { kind: 'edit', name: 'patch', rawInput: {}, content: preview },
        },
        '/project',
      ),
      null,
    );
  });

  it('fail closed for vendor edit+name:patch with label-only rawInput and diff preview', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: {
            kind: 'edit',
            name: 'patch',
            rawInput: { description: 'only a label' },
            content: preview,
          },
        },
        '/project',
      ),
      null,
    );
  });

  it('fail closed for vendor edit+name:apply_patch with missing rawInput', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: { kind: 'edit', name: 'apply_patch', content: preview },
        },
        '/project',
      ),
      null,
    );
  });

  it('fail closed for vendor edit+name:apply_patch with empty rawInput object', () => {
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: { kind: 'edit', name: 'apply_patch', rawInput: {} },
        },
        '/project',
      ),
      null,
    );
  });

  it('fail closed for patch rawInput with blank or wrong-type patchText', () => {
    const preview = [{ type: 'diff', path: 'a.txt', oldText: '', newText: 'A' }];
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: { kind: 'patch', rawInput: { patchText: '   ' }, content: preview },
        },
        '/project',
      ),
      null,
    );
    assert.equal(
      permissionActionFromAcpParams(
        {
          title: 'patch',
          toolCall: { kind: 'patch', rawInput: { patchText: 42 }, content: preview },
        },
        '/project',
      ),
      null,
    );
  });

  it('binds vendor edit+name:apply_patch when patchText raw material is present', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    const bound = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'edit',
          name: 'apply_patch',
          rawInput: { patchText: '*** Begin Patch\n*** End Patch' },
          content: preview,
        },
      },
      '/project',
    );
    assert.equal(bound?.type, 'ask_approval');
    if (bound?.type !== 'ask_approval' || bound.requested_action.type !== 'run_command') {
      throw new Error('expected run_command approval');
    }
    assert.ok(bound.requested_action.command.includes('kind:patch'));
    assert.ok(bound.requested_action.command.includes('patchText'));
  });

  it('binds vendor edit+name:patch when patchText raw material is present', () => {
    const preview = [{ type: 'diff', path: '/project/dest', oldText: 'x', newText: 'y' }];
    const bound = permissionActionFromAcpParams(
      {
        title: 'patch',
        toolCall: {
          kind: 'edit',
          name: 'patch',
          rawInput: { patchText: '*** Begin Patch\n*** End Patch' },
          content: preview,
        },
      },
      '/project',
    );
    assert.equal(bound?.type, 'ask_approval');
    if (bound?.type !== 'ask_approval' || bound.requested_action.type !== 'run_command') {
      throw new Error('expected run_command approval');
    }
    assert.ok(bound.requested_action.command.includes('kind:patch'));
    assert.ok(bound.requested_action.command.includes('patchText'));
  });
});
