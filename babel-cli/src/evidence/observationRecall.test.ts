import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ObservationCursorError,
  captureApprovedObservation,
  readObservationPage,
  resolveObservation,
  type CallerContextV1,
  type CaptureApprovedObservationInputV1,
  type ObservationRefV1,
  type ObservationStorageContextV1,
} from './observationStore.js';

const FIXED_CLOCK = (): string => '2026-09-19T00:00:00.000Z';

function skipIfSymlinkUnavailable(t: TestContext, error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) return false;
  t.skip(`symlink creation unavailable on this host: ${code}`);
  return true;
}

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `babel-recall-${label}-`));
}

function storage(root: string): ObservationStorageContextV1 {
  return { storage_root: root, clock: FIXED_CLOCK };
}

function caller(observationId: string, overrides: Partial<CallerContextV1> = {}): CallerContextV1 {
  return {
    principal_id: 'agent:main',
    authorized_observation_ids: [observationId],
    ...overrides,
  };
}

function capture(
  root: string,
  content: string,
  channel: 'stdout' | 'stderr' = 'stdout',
): ObservationRefV1 {
  const input: CaptureApprovedObservationInputV1 = {
    invocation: {
      operation_id: `op-${channel}-${content.length}`,
      task_id: 'task-1',
      run_id: 'run-1',
    },
    sections: [{ channel, content }],
    execution_status: 'succeeded',
    permitted_principals: ['agent:main', 'agent:child'],
    data_policy: {
      approved: true,
      policy_version: 'policy-v1',
      redaction_policy_version: 'redaction-v1',
    },
  };
  const result = captureApprovedObservation(input, storage(root));
  assert.equal(result.status, 'captured');
  if (result.status !== 'captured') throw new Error('capture failed');
  return result.observation;
}

test('authorized caller resolves; foreign principal and missing membership are denied', () => {
  const root = tempRoot('authz');
  try {
    const observation = capture(root, 'sensitive output');
    const ok = resolveObservation(observation.observation_id, caller(observation.observation_id), storage(root));
    assert.equal(ok.status, 'resolved');

    const foreign = resolveObservation(
      observation.observation_id,
      caller(observation.observation_id, { principal_id: 'agent:foreign' }),
      storage(root),
    );
    assert.equal(foreign.status, 'denied');
    if (foreign.status === 'denied') assert.equal(foreign.policy, 'principal');

    const noMembership = resolveObservation(
      observation.observation_id,
      { principal_id: 'agent:main', authorized_observation_ids: [] },
      storage(root),
    );
    assert.equal(noMembership.status, 'denied');
    if (noMembership.status === 'denied') assert.equal(noMembership.policy, 'membership');

    const readOnlyChild = resolveObservation(
      observation.observation_id,
      caller(observation.observation_id, { principal_id: 'agent:child', read_only: true }),
      storage(root),
    );
    assert.equal(readOnlyChild.status, 'resolved');

    const inherited = resolveObservation(
      observation.observation_id,
      {
        principal_id: 'agent:fork',
        authorized_observation_ids: [observation.observation_id],
        inherited_from: 'agent:main',
      },
      storage(root),
    );
    assert.equal(inherited.status, 'resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hash-guessed recall and invalid handles stay explicitly unresolved', () => {
  const root = tempRoot('hash-guess');
  try {
    const observation = capture(root, 'known content');
    const sha = createHash('sha256').update('known content', 'utf8').digest('hex');
    const guessed = resolveObservation(
      `obs:${sha}`,
      caller(`obs:${sha}`),
      storage(root),
    );
    assert.equal(guessed.status, 'unavailable');

    const malformed = resolveObservation('../../etc/passwd', caller('../../etc/passwd'), storage(root));
    assert.equal(malformed.status, 'unavailable');

    // Knowing the id is still not permission.
    const guessedRealId = resolveObservation(
      observation.observation_id,
      caller('obs:something-else'),
      storage(root),
    );
    assert.equal(guessedRealId.status, 'denied');

    // Deleted reference stays unresolved, never reinterpreted.
    unlinkSync(refPath(root, observation.observation_id));
    const deleted = resolveObservation(observation.observation_id, caller(observation.observation_id), storage(root));
    assert.equal(deleted.status, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tampered payload bytes fail integrity resolution', () => {
  const root = tempRoot('tamper');
  try {
    const observation = capture(root, 'tamper me');
    const payload = observation.payloads[0]!;
    writeFileSync(join(root, payload.object_key), 'evil'.repeat(payload.byte_length), 'utf8');
    const result = resolveObservation(observation.observation_id, caller(observation.observation_id), storage(root));
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.match(result.reason, /size mismatch|hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded pages advance over a long single line and reach EOF', () => {
  const root = tempRoot('longline');
  try {
    const observation = capture(root, 'x'.repeat(1000));
    let cursor: string | null = null;
    let assembled = '';
    let pages = 0;
    for (;;) {
      const page = readObservationPage(
        observation.observation_id,
        cursor,
        { max_bytes: 100 },
        caller(observation.observation_id),
        storage(root),
      );
      assert.equal(page.status, 'page');
      if (page.status !== 'page') return;
      assembled += page.content;
      pages++;
      if (page.eof) {
        assert.equal(page.next_cursor, null);
        break;
      }
      assert.notEqual(page.next_cursor, cursor);
      cursor = page.next_cursor;
      assert.ok(pages < 20, 'cursor must make progress');
    }
    assert.equal(assembled, 'x'.repeat(1000));
    assert.equal(pages, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('UTF-8 page boundaries never split a code point and preserve all content', () => {
  const root = tempRoot('utf8');
  try {
    const original = 'A😀B🙂C';
    const observation = capture(root, original);
    let cursor: string | null = null;
    let assembled = '';
    let pages = 0;
    for (;;) {
      const page = readObservationPage(
        observation.observation_id,
        cursor,
        { max_bytes: 2 },
        caller(observation.observation_id),
        storage(root),
      );
      assert.equal(page.status, 'page');
      if (page.status !== 'page') return;
      assert.doesNotMatch(page.content, /\uFFFD/);
      assembled += page.content;
      pages++;
      if (page.eof) break;
      cursor = page.next_cursor;
      assert.ok(pages < 10, 'must make progress');
    }
    assert.equal(assembled, original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CRLF is preserved and offsets stay on original bytes', () => {
  const root = tempRoot('crlf');
  try {
    const original = 'a\r\nb\r\nc';
    const observation = capture(root, original);
    const first = readObservationPage(
      observation.observation_id,
      null,
      { max_bytes: 3 },
      caller(observation.observation_id),
      storage(root),
    );
    assert.equal(first.status, 'page');
    if (first.status !== 'page') return;
    assert.equal(first.content, 'a\r\n');
    assert.equal(first.returned_bytes, 3);
    assert.equal(first.byte_offset_basis, 'original_payload_bytes');
    assert.ok(first.next_cursor);
    const second = readObservationPage(
      observation.observation_id,
      first.next_cursor,
      { max_bytes: 100 },
      caller(observation.observation_id),
      storage(root),
    );
    assert.equal(second.status, 'page');
    if (second.status !== 'page') return;
    assert.equal(second.content, 'b\r\nc');
    assert.equal(second.eof, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty payload, offset past EOF, and absent section are explicit', () => {
  const root = tempRoot('edge');
  try {
    const empty = capture(root, '');
    const emptyPage = readObservationPage(
      empty.observation_id,
      null,
      {},
      caller(empty.observation_id),
      storage(root),
    );
    assert.equal(emptyPage.status, 'page');
    if (emptyPage.status === 'page') {
      assert.equal(emptyPage.content, '');
      assert.equal(emptyPage.eof, true);
      assert.equal(emptyPage.next_cursor, null);
    }

    const beyond = readObservationPage(
      empty.observation_id,
      'v1:999',
      {},
      caller(empty.observation_id),
      storage(root),
    );
    assert.equal(beyond.status, 'page');
    if (beyond.status === 'page') {
      assert.equal(beyond.actual_offset, 0);
      assert.equal(beyond.eof, true);
    }

    const absentSection = readObservationPage(
      empty.observation_id,
      null,
      {},
      caller(empty.observation_id),
      storage(root),
      'stderr',
    );
    assert.equal(absentSection.status, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('excessive bounds clamp with reported effective values; zero/negative and bad cursors reject', () => {
  const root = tempRoot('bounds');
  try {
    const observation = capture(root, 'abc');
    const page = readObservationPage(
      observation.observation_id,
      null,
      { max_bytes: 100_000_000 },
      caller(observation.observation_id),
      storage(root),
    );
    assert.equal(page.status, 'page');
    if (page.status === 'page') {
      assert.equal(page.clamped, true);
      assert.equal(page.requested_max_bytes, 100_000_000);
      assert.equal(page.effective_max_bytes, 1024 * 1024);
    }

    assert.throws(
      () =>
        readObservationPage(
          observation.observation_id,
          null,
          { max_bytes: 0 },
          caller(observation.observation_id),
          storage(root),
        ),
      ObservationCursorError,
    );
    assert.throws(
      () =>
        readObservationPage(
          observation.observation_id,
          'garbage',
          {},
          caller(observation.observation_id),
          storage(root),
        ),
      ObservationCursorError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('base64 representation returns declared binary bytes', () => {
  const root = tempRoot('binary');
  try {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x20]);
    const result = captureApprovedObservation(
      {
        invocation: { operation_id: 'op-bin', task_id: 'task-1', run_id: 'run-1' },
        sections: [{ channel: 'structured', content: bytes }],
        execution_status: 'succeeded',
        permitted_principals: ['agent:main'],
        data_policy: {
          approved: true,
          policy_version: 'policy-v1',
          redaction_policy_version: 'redaction-v1',
        },
      },
      storage(root),
    );
    assert.equal(result.status, 'captured');
    if (result.status !== 'captured') return;
    const page = readObservationPage(
      result.observation.observation_id,
      null,
      {},
      caller(result.observation.observation_id),
      storage(root),
      'structured',
    );
    assert.equal(page.status, 'page');
    if (page.status !== 'page') return;
    assert.equal(page.encoding, 'base64');
    assert.equal(Buffer.from(page.content, 'base64').toString('hex'), '00ff1020');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recall rejects symlinked object files and symlinked ancestor directories', (t) => {
  const root = tempRoot('recall-symlink');
  const outside = tempRoot('recall-symlink-outside');
  try {
    const observation = capture(root, 'contained recall bytes');
    const payload = observation.payloads[0]!;
    const objectPath = join(root, payload.object_key);
    const objectDir = dirname(objectPath);
    const outsideFile = join(outside, 'copied.bin');
    writeFileSync(outsideFile, 'contained recall bytes', 'utf8');

    // 1) object file replaced by a symlink to an outside file.
    unlinkSync(objectPath);
    try {
      symlinkSync(outsideFile, objectPath);
    } catch (error) {
      if (skipIfSymlinkUnavailable(t, error)) return;
      throw error;
    }
    const fileLink = resolveObservation(
      observation.observation_id,
      caller(observation.observation_id),
      storage(root),
    );
    assert.equal(fileLink.status, 'unavailable');
    if (fileLink.status === 'unavailable') assert.match(fileLink.reason, /symlink|reparse/);
    const filePage = readObservationPage(
      observation.observation_id,
      null,
      {},
      caller(observation.observation_id),
      storage(root),
    );
    assert.equal(filePage.status, 'unavailable');

    // 2) object prefix directory replaced by a symlink to an outside directory
    //    that contains a byte-identical object.
    unlinkSync(objectPath);
    rmSync(objectDir, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${payload.sha256}.bin`), 'contained recall bytes', 'utf8');
    try {
      symlinkSync(outside, objectDir);
    } catch (error) {
      if (skipIfSymlinkUnavailable(t, error)) return;
      throw error;
    }
    const dirLink = resolveObservation(
      observation.observation_id,
      caller(observation.observation_id),
      storage(root),
    );
    assert.equal(dirLink.status, 'unavailable');
    if (dirLink.status === 'unavailable') assert.match(dirLink.reason, /symlink|reparse/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function refPath(root: string, observationId: string): string {
  const hex = observationId.replace(/^obs:/, '');
  return join(root, 'refs', hex.slice(0, 2), `${hex}.json`);
}
