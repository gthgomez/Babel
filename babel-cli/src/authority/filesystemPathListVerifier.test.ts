import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { sep } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sha256Canonical } from '../acceptance/canonical.js'
import {
  INVENTORY_VERIFICATION_EVIDENCE_MODE,
  captureFilesystemSourceBaseline,
  parseMarkdownBulletPaths,
  setVerifierReadAttemptRecorder,
  type VerifierReadAttemptV1,
  verifyFilesystemPathList,
} from './filesystemPathListVerifier.js'
import {
  declarationContentHash,
  normalizeDeclarationRepoRelativePath,
  parseTrustedHostFilesystemPathListDeclaration,
  TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
} from './trustedHostFilesystemPathList.js'

const USER_REQUEST =
  'Update the path index to match the current tree. Use another method if a command cannot run; confirm listed paths.'

function declaration(overrides: {
  target?: string
  roots?: string[]
  preserved?: string[]
  userRequest?: string
} = {}) {
  const user_request = overrides.userRequest ?? USER_REQUEST
  return parseTrustedHostFilesystemPathListDeclaration({
    schema_version: 1,
    kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
    declaration_id: randomUUID(),
    user_request,
    user_request_digest: sha256Canonical(user_request),
    target_document: overrides.target ?? 'meta/tree-index.md',
    format_profile: 'markdown_bullet_paths',
    inventory_scope: { roots: overrides.roots ?? ['apps', 'packages'] },
    coverage: { mode: 'complete_scoped_inventory' },
    preserved_input_selectors: overrides.preserved ?? ['docs/notes.md'],
    limits: { max_document_bytes: 32_000, max_entries: 128 },
  })
}

function writeMap(root: string, rel: string, paths: string[]) {
  const body = paths.map(path => `- ${path}`).join('\n') + '\n'
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf8')
}

function seedTree(root: string) {
  mkdirSync(join(root, 'apps', 'web'), { recursive: true })
  mkdirSync(join(root, 'packages', 'api'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'entry.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'packages', 'api', 'service.mjs'), 'export {}\n', 'utf8')
  writeFileSync(join(root, 'docs', 'notes.md'), '# notes\n', 'utf8')
  return ['apps/web/entry.mjs', 'packages/api/service.mjs']
}

test('trusted-host declaration binds exact user_request digest', () => {
  const decl = declaration()
  assert.equal(decl.user_request, USER_REQUEST)
  assert.equal(decl.user_request_digest, sha256Canonical(USER_REQUEST))
  assert.throws(
    () =>
      parseTrustedHostFilesystemPathListDeclaration({
        schema_version: 1,
        kind: TRUSTED_HOST_FILESYSTEM_PATH_LIST_DECLARATION_KIND,
        declaration_id: 'x',
        user_request: USER_REQUEST,
        user_request_digest: '0'.repeat(64),
        target_document: 'meta/tree-index.md',
        format_profile: 'markdown_bullet_paths',
        inventory_scope: { roots: ['apps'] },
        coverage: { mode: 'complete_scoped_inventory' },
        preserved_input_selectors: [],
        limits: { max_document_bytes: 1000, max_entries: 10 },
      }),
    /user_request_digest mismatch/,
  )
})

test('parseMarkdownBulletPaths rejects empty and malformed documents', () => {
  const limits = { max_document_bytes: 1000, max_entries: 10 }
  assert.equal(parseMarkdownBulletPaths('', limits).ok, false)
  assert.equal(parseMarkdownBulletPaths('- ../escape\n', limits).ok, false)
  assert.equal(parseMarkdownBulletPaths('- valid/ok\n- \n', limits).ok, false)
  assert.equal(normalizeDeclarationRepoRelativePath('apps\\web'), 'apps/web')
  assert.equal(normalizeDeclarationRepoRelativePath('\\apps\\web'), null)
})

test('valid complete inventory passes with arbitrary target layout', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-ok-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration({ target: 'maps/custom-index.md', preserved: ['docs/notes.md'] })
  writeMap(root, decl.target_document, paths)
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'passed')
  assert.equal(result.checks.coverage_complete.status, 'pass')
  assert.equal(result.inventory_missing_paths.length, 0)
  assert.equal(result.inventory_extra_paths.length, 0)
})

test('duplicate declared paths fail', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-dup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, [
    'apps/web/entry.mjs',
    'apps/web/entry.mjs',
    'packages/api/service.mjs',
  ])
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.equal(result.checks.no_duplicate_entries.status, 'fail')
})

test('missing inventory paths fail coverage', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-miss-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, ['apps/web/entry.mjs'])
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.match(result.inventory_missing_paths.join(','), /packages\/api\/service\.mjs/)
})

test('extra declared paths fail coverage', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-extra-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, [...paths, 'apps/web/phantom.mjs'])
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.inventory_extra_paths, ['apps/web/phantom.mjs'])
})

test('inventory drift vs current tree fails coverage (baseline snapshot not compared)', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-inv-change-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, paths)
  const baseline = captureFilesystemSourceBaseline(root, decl)
  writeFileSync(join(root, 'packages', 'api', 'new-module.mjs'), 'export {}\n', 'utf8')
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.equal(result.inventory_evidence_mode, INVENTORY_VERIFICATION_EVIDENCE_MODE)
  assert.ok(result.inventory_missing_paths.includes('packages/api/new-module.mjs'))
})

test('stale baseline inventory_snapshot does not fail when document matches current tree', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-inv-stale-base-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, paths)
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const staleBaseline = {
    ...baseline,
    inventory_snapshot: Object.freeze(['phantom/only-in-snapshot.mjs']),
  }
  const result = verifyFilesystemPathList(root, decl, staleBaseline)
  assert.equal(result.status, 'passed')
  assert.equal(result.inventory_evidence_mode, INVENTORY_VERIFICATION_EVIDENCE_MODE)
})

test('symlink escape outside project root is rejected', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-sym-'))
  const outside = mkdtempSync(join(tmpdir(), 'fs-path-list-out-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  seedTree(root)
  const decl = declaration({ roots: ['apps'], preserved: [] })
  writeMap(root, decl.target_document, ['apps/web/entry.mjs'])
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const escapeLink = join(root, 'apps', 'web', 'outside-link.mjs')
  writeFileSync(join(outside, 'secret.mjs'), 'export {}\n', 'utf8')
  symlinkSync(join(outside, 'secret.mjs'), escapeLink)
  writeMap(root, decl.target_document, ['apps/web/entry.mjs', 'apps/web/outside-link.mjs'])
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason_code, 'inventory_scope_invalid')
  assert.ok(result.inventory_scope_errors.some(err => err.includes('symlink_in_inventory_scope')))
})

test('credential-class declared paths are denied at parse and resolve', t => {
  const limits = { max_document_bytes: 8000, max_entries: 32 }
  assert.equal(parseMarkdownBulletPaths('- apps/web/.env\n', limits).ok, false)
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-cred-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, paths)
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const tampered = readFileSync(join(root, decl.target_document), 'utf8') + '- apps/web/.env\n'
  writeFileSync(join(root, decl.target_document), tampered, 'utf8')
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.equal(result.checks.document_parseable.status, 'fail')
})

test('protected-source drift fails preserved check', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-drift-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration({ preserved: ['docs/notes.md'] })
  writeMap(root, decl.target_document, paths)
  const baseline = captureFilesystemSourceBaseline(root, decl)
  writeFileSync(join(root, 'docs', 'notes.md'), '# changed\n', 'utf8')
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.preserved_drift_paths, ['docs/notes.md'])
  assert.equal(result.checks.preserved_inputs_unchanged.status, 'fail')
})

test('baseline captured from actual filesystem not host answer list', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-base-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  const decl = declaration()
  const baseline = captureFilesystemSourceBaseline(root, decl)
  assert.ok(baseline.inventory_snapshot.includes('apps/web/entry.mjs'))
  assert.equal(baseline.preserved['docs/notes.md']?.kind, 'file')
  assert.match(baseline.preserved['docs/notes.md']?.content_sha256 ?? '', /^[0-9a-f]{64}$/)
  assert.equal(baseline.declaration_hash, declarationContentHash(decl))
})

test('missing inventory scope root fails closed', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-scope-miss-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  const decl = declaration({ roots: ['apps', 'packages', 'missing-root'] })
  assert.throws(() => captureFilesystemSourceBaseline(root, decl), (err: unknown) => {
    return err instanceof Error && err.message.includes('missing_scope_root:missing-root')
  })
})

test('target document over byte limit fails before full parse', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-big-doc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  const decl = declaration({ roots: ['apps'], preserved: [] })
  const huge = '- apps/web/entry.mjs\n' + 'x'.repeat(decl.limits.max_document_bytes)
  mkdirSync(join(root, 'meta'), { recursive: true })
  writeFileSync(join(root, decl.target_document), huge, 'utf8')
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason_code, 'document_too_large')
})

test('parse failure skips preserved check', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-parse-fail-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  const decl = declaration({ preserved: ['docs/notes.md'] })
  mkdirSync(join(root, 'meta'), { recursive: true })
  writeFileSync(join(root, decl.target_document), '- ../escape\n', 'utf8')
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.checks.preserved_inputs_unchanged.status, 'skip')
  assert.equal(result.checks.preserved_inputs_unchanged.reason_code, 'not_evaluated')
})

function secretSegmentPath(root: string): string {
  return `${root}${sep}secrets${sep}`
}

function assertNoSecretReadAttempts(attempts: readonly VerifierReadAttemptV1[], root: string): void {
  const secretSegment = secretSegmentPath(root)
  const secretAttempts = attempts.filter(attempt => attempt.absolute_path.includes(secretSegment))
  assert.deepEqual(
    secretAttempts,
    [],
    `expected no verifier read attempts under secrets; observed: ${JSON.stringify(secretAttempts)}`,
  )
}

function linkDirOrSkip(t: import('node:test').TestContext, target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`symlink creation unavailable: ${code}`)
      return false
    }
    throw error
  }
}

test('ancestor alias into secrets denies target before verifier read seam (observed)', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-anc-target-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const attempts: VerifierReadAttemptV1[] = []
  setVerifierReadAttemptRecorder(attempt => attempts.push(attempt))
  t.after(() => setVerifierReadAttemptRecorder(undefined))
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, 'secrets', 'index.md'), 'CANARY_SECRET_TARGET\n', 'utf8')
  if (!linkDirOrSkip(t, join(root, 'secrets'), join(root, 'meta'))) return
  const paths = seedTree(root)
  const decl = declaration({ target: 'meta/index.md', roots: ['apps'], preserved: [] })
  writeMap(root, decl.target_document, paths)
  const baseline = captureFilesystemSourceBaseline(root, decl)
  const result = verifyFilesystemPathList(root, decl, baseline)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason_code, 'target_document_symlink')
  assertNoSecretReadAttempts(attempts, root)
})

test('ancestor alias into secrets denies preserved capture before verifier read seam (observed)', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-anc-preserved-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const attempts: VerifierReadAttemptV1[] = []
  setVerifierReadAttemptRecorder(attempt => attempts.push(attempt))
  t.after(() => setVerifierReadAttemptRecorder(undefined))
  seedTree(root)
  rmSync(join(root, 'docs'), { recursive: true, force: true })
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, 'secrets', 'notes.md'), 'CANARY_SECRET_PRESERVED\n', 'utf8')
  if (!linkDirOrSkip(t, join(root, 'secrets'), join(root, 'docs'))) return
  const decl = declaration({ preserved: ['docs/notes.md'], roots: ['apps'] })
  assert.throws(() => captureFilesystemSourceBaseline(root, decl), /symlink_preserved:docs\/notes\.md/)
  assertNoSecretReadAttempts(attempts, root)
})

test('directory symlink inside scope fails inventory listing', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-dir-sym-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  seedTree(root)
  symlinkSync(join(root, 'apps'), join(root, 'apps', 'self'))
  const decl = declaration({ roots: ['apps'] })
  assert.throws(() => captureFilesystemSourceBaseline(root, decl), /symlink_in_inventory_scope/)
})

test('stage-1 result is diagnostic only (kind label)', t => {
  const root = mkdtempSync(join(tmpdir(), 'fs-path-list-kind-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = seedTree(root)
  const decl = declaration()
  writeMap(root, decl.target_document, paths)
  const result = verifyFilesystemPathList(root, decl, captureFilesystemSourceBaseline(root, decl))
  assert.equal(result.kind, 'filesystem_path_list_verifier_result_v1')
  assert.ok(result.status === 'passed' || result.status === 'failed')
})
