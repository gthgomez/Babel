/**
 * Drives ChatEngine.submitMessageStream — the live entry path — through
 * evaluateSubmitTaskAuthorityHalt. Clarification/deny must halt before tools.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine } from './chatEngine.js';
import { parseLeaseJson } from '../authority/lease.js';

const prevLease = process.env['BABEL_AUTONOMY_LEASE'];

after(() => {
  if (prevLease === undefined) delete process.env['BABEL_AUTONOMY_LEASE'];
  else process.env['BABEL_AUTONOMY_LEASE'] = prevLease;
});

function installLease(allowed: string[], extra: Record<string, unknown> = {}): void {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'engine-halt',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: allowed,
      ...extra,
    }),
  );
  assert.ok(parsed.ok);
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify(parsed.lease);
}

async function collect(engine: ChatEngine, message: string) {
  const events: Array<{ type: string; answer?: string; error?: string; tool?: string }> = [];
  for await (const ev of engine.submitMessageStream(message)) {
    events.push(ev);
    if (ev.type === 'done' || ev.type === 'failed' || ev.type === 'cancelled') break;
  }
  return events;
}

test('submitMessageStream: merge it with two leased PRs yields clarification, no tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-halt-'));
  try {
    installLease(
      [
        'inspect_repository',
        'search_repository',
        'edit_task_files',
        'run_tests',
        'commit_ship_set',
        'push_feature_branch',
        'merge',
      ],
      { constraints: { allowedPullRequests: [88, 90] } },
    );
    const engine = new ChatEngine({ task: 'merge it', projectRoot: root });
    const events = await collect(engine, 'merge it');
    assert.equal(events.some((e) => e.type === 'tool_start'), false);
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, JSON.stringify(events.map((e) => e.type)));
    assert.match(done.answer ?? '', /Which PR/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('submitMessageStream: merge PR #88 without merge capability yields deny, no tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-halt-deny-'));
  try {
    installLease(['inspect_repository', 'edit_task_files', 'run_tests']);
    const engine = new ChatEngine({ task: 'merge PR #88', projectRoot: root });
    const events = await collect(engine, 'merge PR #88');
    assert.equal(events.some((e) => e.type === 'tool_start'), false);
    const failed = events.find((e) => e.type === 'failed');
    assert.ok(failed, JSON.stringify(events.map((e) => e.type)));
    assert.match(failed.error ?? '', /DENY_MISSING_AUTHORITY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
