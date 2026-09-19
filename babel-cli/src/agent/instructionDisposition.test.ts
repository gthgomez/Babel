/**
 * #216(B) — delivered-instruction disposition.
 *
 * The compiler's `InstructionManifestV1` previously described only
 * compiler-selected stack entries. Session identity files (SOUL /
 * AGENT_IDENTITY / AGENTS / CLAUDE / ENGINEERING / PROJECT_CONTEXT) are
 * delivered as `systemContext` but were absent from the manifest. These tests
 * assert the delivered identity files are reported with source path, tier,
 * digests, and truncation, and that trusted-review isolation is preserved.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import {
  loadProjectSessionIdentity,
  loadProjectSessionIdentityDispositionSync,
  loadProjectSessionIdentityWithDisposition,
} from '../interactive/identity.js';
import {
  INSTRUCTION_MANIFEST_FILENAME,
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
} from './liveSessionBridge.js';
import { instructionManifestsEqual } from './instructionManifest.js';

const created: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function writeIdentityFixture(root: string, overrides: Record<string, string> = {}): void {
  const files: Record<string, string> = {
    'SOUL.md': '# Soul\nbe careful\n',
    'AGENT_IDENTITY.md': '# Identity\nsenior engineer\n',
    'AGENTS.md': '# Agent Instructions\nread before write\n',
    'CLAUDE.md': '# Project Instructions\nno unsafe edits\n',
    'ENGINEERING.md': '# Engineering Standards\ntests required\n',
    'PROJECT_CONTEXT.md': '# Project Context\ntopology\n',
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content, 'utf-8');
}

describe('#216 delivered-instruction disposition', () => {
  it('records every delivered identity file with source, tier, and digests', async () => {
    const root = makeRoot('babel-id-disp-');
    writeIdentityFixture(root);

    const disposition = loadProjectSessionIdentityDispositionSync(root, root);
    const ids = disposition.fragments.map((f) => f.id);
    assert.deepEqual(ids, [
      'session:soul',
      'session:agent_identity',
      'session:agents',
      'session:claude',
      'session:engineering',
      'session:project_context',
    ]);

    const agents = disposition.fragments.find((f) => f.id === 'session:agents');
    assert.ok(agents);
    assert.equal(agents.source, join(root, 'AGENTS.md'));
    assert.equal(agents.tier, 'project');
    assert.equal(agents.truncated, false);
    assert.match(agents.source_digest ?? '', /^[0-9a-f]{64}$/);
    assert.match(agents.delivered_content_digest, /^[0-9a-f]{64}$/);
    assert.ok(agents.delivered_content.includes('read before write'));

    // The async reader and the manifest-facing sync reader agree byte-for-byte.
    const asyncDisposition = await loadProjectSessionIdentityWithDisposition(root, root);
    assert.equal(asyncDisposition.systemContext, disposition.systemContext);
    assert.equal(asyncDisposition.fragments.length, disposition.fragments.length);
    assert.equal(
      await loadProjectSessionIdentity(root, root),
      disposition.systemContext,
      'string API must remain the exact delivered systemContext',
    );
  });

  it('flags truncation of an over-cap identity file', () => {
    const root = makeRoot('babel-id-trunc-');
    writeIdentityFixture(root, { 'AGENTS.md': '# Agent Instructions\n' + 'x'.repeat(4000) + '\n' });

    const disposition = loadProjectSessionIdentityDispositionSync(root, root);
    const agents = disposition.fragments.find((f) => f.id === 'session:agents');
    assert.ok(agents);
    assert.equal(agents.truncated, true);
    assert.equal(agents.source_length, 4022);
    assert.equal(agents.delivered_chars, agents.delivered_content.length);
    assert.notEqual(agents.source_digest, agents.delivered_content_digest);
  });

  it('reflects delivered identity fragments in the InstructionManifestV1', () => {
    const root = makeRoot('babel-id-manifest-');
    writeIdentityFixture(root);
    const disposition = loadProjectSessionIdentityDispositionSync(root, root);

    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: root,
      task: 'inventory the repo',
      systemContextFragments: disposition.fragments,
    });

    const fragment = authority.instructionManifest.fragments.find((f) => f.rule_id === 'session:agents');
    assert.ok(fragment, 'delivered AGENTS.md must have a manifest fragment');
    assert.equal(fragment.source, join(root, 'AGENTS.md'));
    assert.equal(fragment.precedence, 'identity');
    assert.equal(fragment.delivered_content_digest, disposition.fragments.find((f) => f.id === 'session:agents')!.delivered_content_digest);
    assert.equal(fragment.included_chars, disposition.fragments.find((f) => f.id === 'session:agents')!.delivered_chars);
    assert.match(fragment.content_preview ?? '', /read before write/);
  });

  it('does not invent identity fragments when none are supplied (documents the gap)', () => {
    const root = makeRoot('babel-id-nogap-');
    writeIdentityFixture(root);
    const authority = resolveLiveSessionAuthority({ mode: 'chat', projectRoot: root, task: 't' });
    assert.equal(
      authority.instructionManifest.fragments.some((f) => f.rule_id.startsWith('session:')),
      false,
      'without the disposition input the manifest still omits delivered identity',
    );
  });

  it('trusted-review instructionRoot isolates candidate target instructions', () => {
    const target = makeRoot('babel-id-target-');
    const trusted = makeRoot('babel-id-trusted-');
    writeFileSync(join(target, 'AGENTS.md'), '# Agent Instructions\nTARGET_CANDIDATE\n', 'utf-8');
    writeFileSync(join(trusted, 'AGENTS.md'), '# Agent Instructions\nTRUSTED_VERIFIER\n', 'utf-8');

    const trustedIdentity = loadProjectSessionIdentityDispositionSync(trusted, trusted);
    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: target,
      instructionRoot: trusted,
      task: 'review the candidate change',
      systemContextFragments: trustedIdentity.fragments,
    });

    const sources = authority.instructionManifest.fragments.map((f) => f.source);
    assert.ok(
      sources.includes(join(trusted, 'AGENTS.md')),
      'trusted instruction root must be represented',
    );
    assert.equal(
      sources.some((s) => s.includes(join(target, 'AGENTS.md'))),
      false,
      'candidate-controlled target AGENTS.md must never enter the instruction authority',
    );
    assert.equal(
      authority.instructionManifest.fragments.some((f) => f.content_preview?.includes('TARGET_CANDIDATE')),
      false,
    );
  });

  it('nested instruction files are omitted (no ancestor/subdirectory walk)', () => {
    const parent = makeRoot('babel-id-nested-');
    const root = join(parent, 'project');
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'AGENTS.md'), '# Agent Instructions\nNESTED\n', 'utf-8');

    const disposition = loadProjectSessionIdentityDispositionSync(root, parent);
    assert.equal(disposition.fragments.some((f) => f.id === 'session:agents'), false);
    assert.equal(disposition.fragments.some((f) => f.source.includes(join('pkg', 'AGENTS.md'))), false);
  });

  it('manifest survives durable persist/reload unchanged (compacted continuation)', () => {
    const root = makeRoot('babel-id-resume-');
    const runDir = makeRoot('babel-id-rundir-');
    writeIdentityFixture(root);
    const disposition = loadProjectSessionIdentityDispositionSync(root, root);

    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: root,
      task: 'resume this task',
      systemContextFragments: disposition.fragments,
    });
    persistLiveSessionAuthority(runDir, authority);

    const reloaded = loadLiveSessionAuthorityStrict(runDir);
    assert.ok(reloaded.instructionManifest);
    assert.ok(
      instructionManifestsEqual(reloaded.instructionManifest, authority.instructionManifest),
      'durable manifest must be authority-equivalent after reload',
    );
    assert.ok(
      reloaded.instructionManifest.fragments.some((f) => f.rule_id === 'session:agents'),
      'delivered identity fragment survives resume/continuation',
    );
    assert.ok(INSTRUCTION_MANIFEST_FILENAME.length > 0);
  });
});
