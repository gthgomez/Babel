/**
 * Delivered instructions are AGENTS.md, ENGINEERING.md, and the user-wide
 * context file. The session identity reader stays empty so it cannot paste
 * CLAUDE.md, a sibling example, or a second copy of AGENTS.md.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { compileChatStack } from './chatStackCompile.js';
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
const previousUserContext = process.env['BABEL_USER_CONTEXT'];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(() => {
  if (previousUserContext === undefined) delete process.env['BABEL_USER_CONTEXT'];
  else process.env['BABEL_USER_CONTEXT'] = previousUserContext;
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function writeLegacyIdentityFiles(root: string): void {
  const files: Record<string, string> = {
    'SOUL.md': '# Soul\nbe careful\n',
    'AGENT_IDENTITY.md': '# Identity\nsenior engineer\n',
    'AGENTS.md': '# Agent Instructions\nread before write\n',
    'CLAUDE.md': '# Project Instructions\nCLAUDE_SHOULD_NOT_LOAD\n',
    'ENGINEERING.md': '# Engineering Standards\nENGINEERING_REQUIREMENT\n',
    'PROJECT_CONTEXT.md': '# Project Context\nPROJECT_CONTEXT_SHOULD_NOT_LOAD\n',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content, 'utf-8');
}

describe('delivered project instructions', () => {
  it('keeps the session identity reader empty', async () => {
    const root = makeRoot('babel-id-empty-');
    writeLegacyIdentityFiles(root);
    process.env['BABEL_USER_CONTEXT'] = join(root, 'missing-user-context.md');

    const disposition = loadProjectSessionIdentityDispositionSync(root, root);
    assert.deepEqual(disposition.fragments, []);
    assert.equal(disposition.systemContext, '');

    const asyncDisposition = await loadProjectSessionIdentityWithDisposition(root, root);
    assert.equal(asyncDisposition.systemContext, '');
    assert.deepEqual(asyncDisposition.fragments, []);
    assert.equal(await loadProjectSessionIdentity(root, root), '');
  });

  it('delivers AGENTS.md and ENGINEERING.md and skips CLAUDE.md and PROJECT_CONTEXT.md', () => {
    const root = makeRoot('babel-id-stack-');
    writeLegacyIdentityFiles(root);
    process.env['BABEL_USER_CONTEXT'] = join(root, 'missing-user-context.md');

    const stack = compileChatStack({ projectRoot: root, includeDomainSkill: false });
    assert.equal(
      stack.selected_entries.find((entry) => entry.id === 'identity:agents')?.path,
      join(root, 'AGENTS.md'),
    );
    assert.equal(
      stack.selected_entries.find((entry) => entry.id === 'project:engineering')?.path,
      join(root, 'ENGINEERING.md'),
    );
    assert.match(stack.system_context, /read before write/);
    assert.match(stack.system_context, /ENGINEERING_REQUIREMENT/);
    assert.doesNotMatch(stack.system_context, /CLAUDE_SHOULD_NOT_LOAD/);
    assert.doesNotMatch(stack.system_context, /PROJECT_CONTEXT_SHOULD_NOT_LOAD/);
    assert.equal(stack.system_context.split('read before write').length - 1, 1);
  });

  it('includes the user-wide context file without replacing AGENTS.md', () => {
    const root = makeRoot('babel-id-user-');
    writeFileSync(join(root, 'AGENTS.md'), '# Agent Instructions\nread before write\n', 'utf-8');
    const contextPath = join(root, 'context.md');
    writeFileSync(contextPath, 'USER_CONTEXT_REMEMBERED\n', 'utf-8');
    process.env['BABEL_USER_CONTEXT'] = contextPath;

    const stack = compileChatStack({ projectRoot: root, includeDomainSkill: false });
    const user = stack.selected_entries.find((entry) => entry.id === 'user:context');
    assert.equal(user?.path, contextPath);
    assert.match(stack.system_context, /USER_CONTEXT_REMEMBERED/);
    assert.match(stack.system_context, /read before write/);
    assert.equal(
      stack.content_disposition.find((item) => item.id === 'identity:agents')?.status,
      'included',
    );
    assert.equal(
      stack.content_disposition.find((item) => item.id === 'user:context')?.status,
      'included',
    );
  });

  it('does not scan a sibling repository for CLAUDE.md or ENGINEERING.md', () => {
    const workspace = makeRoot('babel-id-sibling-');
    const project = join(workspace, 'babel');
    const sibling = join(workspace, 'babel-north-star');
    mkdirSync(project);
    mkdirSync(sibling);
    writeFileSync(join(project, 'AGENTS.md'), 'PROJECT_AGENTS\n', 'utf-8');
    writeFileSync(join(sibling, 'CLAUDE.md'), 'SIBLING_CLAUDE\n', 'utf-8');
    writeFileSync(join(sibling, 'ENGINEERING.md'), 'SIBLING_ENGINEERING\n', 'utf-8');
    process.env['BABEL_USER_CONTEXT'] = join(workspace, 'missing-user-context.md');

    const stack = compileChatStack({ projectRoot: project, includeDomainSkill: false });
    assert.match(stack.system_context, /PROJECT_AGENTS/);
    assert.doesNotMatch(stack.system_context, /SIBLING_CLAUDE/);
    assert.doesNotMatch(stack.system_context, /SIBLING_ENGINEERING/);
  });

  it('trusted-review instructionRoot isolates candidate target instructions', () => {
    const target = makeRoot('babel-id-target-');
    const trusted = makeRoot('babel-id-trusted-');
    writeFileSync(join(target, 'AGENTS.md'), '# Agent Instructions\nTARGET_CANDIDATE\n', 'utf-8');
    writeFileSync(join(trusted, 'AGENTS.md'), '# Agent Instructions\nTRUSTED_VERIFIER\n', 'utf-8');
    process.env['BABEL_USER_CONTEXT'] = join(target, 'missing-user-context.md');

    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: target,
      instructionRoot: trusted,
      task: 'review the candidate change',
    });

    const agents = authority.instructionManifest.fragments.find((f) => f.rule_id === 'identity:agents');
    assert.ok(agents);
    assert.equal(agents.source, join(trusted, 'AGENTS.md'));
    assert.match(agents.content_preview ?? '', /TRUSTED_VERIFIER/);
    assert.equal(
      authority.instructionManifest.fragments.some((f) => f.source.includes(join(target, 'AGENTS.md'))),
      false,
    );
    assert.equal(authority.chatStack?.system_context.includes('TARGET_CANDIDATE'), false);
    assert.equal(authority.chatStack?.system_context.includes('TRUSTED_VERIFIER'), true);
  });

  it('loads one parent AGENTS.md and ignores a nested package file', () => {
    const parent = makeRoot('babel-id-nested-');
    const root = join(parent, 'project');
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'AGENTS.md'), '# Agent Instructions\nNESTED_SHOULD_NOT_LOAD\n', 'utf-8');
    process.env['BABEL_USER_CONTEXT'] = join(parent, 'missing-user-context.md');

    const nestedOnly = compileChatStack({ projectRoot: root, includeDomainSkill: false });
    assert.equal(nestedOnly.selected_entries.find((entry) => entry.layer === 'identity')?.id, 'identity:default');
    assert.doesNotMatch(nestedOnly.system_context, /NESTED_SHOULD_NOT_LOAD/);

    writeFileSync(join(parent, 'AGENTS.md'), '# Agent Instructions\nPARENT_AGENTS_LOADED\n', 'utf-8');
    const withParent = compileChatStack({ projectRoot: root, includeDomainSkill: false });
    assert.equal(
      withParent.selected_entries.find((entry) => entry.id === 'identity:agents')?.path,
      join(parent, 'AGENTS.md'),
    );
    assert.match(withParent.system_context, /PARENT_AGENTS_LOADED/);
    assert.doesNotMatch(withParent.system_context, /NESTED_SHOULD_NOT_LOAD/);
  });

  it('records identity:agents on the manifest and reloads it', () => {
    const root = makeRoot('babel-id-resume-');
    const runDir = makeRoot('babel-id-rundir-');
    writeLegacyIdentityFiles(root);
    process.env['BABEL_USER_CONTEXT'] = join(root, 'missing-user-context.md');

    const authority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: root,
      task: 'resume this task',
    });
    const fragment = authority.instructionManifest.fragments.find((f) => f.rule_id === 'identity:agents');
    assert.ok(fragment);
    assert.equal(fragment.source, join(root, 'AGENTS.md'));
    assert.equal(fragment.precedence, 'identity');
    assert.match(fragment.content_preview ?? '', /read before write/);
    assert.equal(
      authority.instructionManifest.fragments.some((f) => f.rule_id.startsWith('session:')),
      false,
    );

    persistLiveSessionAuthority(runDir, authority);
    const reloaded = loadLiveSessionAuthorityStrict(runDir);
    assert.ok(
      instructionManifestsEqual(reloaded.instructionManifest, authority.instructionManifest),
      'durable manifest must be authority-equivalent after reload',
    );
    assert.ok(
      reloaded.instructionManifest.fragments.some((f) => f.rule_id === 'identity:agents'),
    );
    assert.ok(existsSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME)));
  });
});
