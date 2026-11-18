import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FINAL_REVISION_CONTRACT_VERSION,
  GIT_CONFIG_CAPABLE_SUBCOMMANDS,
  GIT_EXEC_WRITE_DENIALS,
  GIT_EXEC_WRITE_DENIAL_PROBES,
  GIT_READ_ONLY_SUBCOMMANDS,
  gitCommandProofReadOnly,
  gitConfigCapability,
  gitConfigEffectUnproven,
  evaluateFinalRevisionWitness,
  hashFinalRevisionFile,
  chatFinalRevisionRequired,
  untestedPathsAfterLastGreenVerifier,
} from './finalRevision.js'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-'))
  writeFileSync(join(root, 'app.ts'), 'export const value = 1\n')
  writeFileSync(join(root, 'app.test.ts'), 'test\n')
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('inspection-only no-change is verified while the inspected bytes are unchanged', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [{ tool: 'read_file', target: 'app.ts', exit_code: 0, read_revision_hash: hash('export const value = 1\n') }]
    const witness = evaluateFinalRevisionWitness({ projectRoot: root, toolCallLog: log })
    assert.equal(witness.status, 'verified')
    assert.equal(witness.verified_against, 'inspection_reads')
    assert.equal(witness.contract, FINAL_REVISION_CONTRACT_VERSION)
  } finally {
    cleanup()
  }
})

test('external editor save after inspection invalidates no-change without deleting bytes', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [{ tool: 'read_file', target: 'app.ts', exit_code: 0, read_revision_hash: hash('export const value = 1\n') }]
    writeFileSync(join(root, 'app.ts'), 'export const value = 2\n')
    const witness = evaluateFinalRevisionWitness({ projectRoot: root, toolCallLog: log })
    assert.equal(witness.status, 'stale')
    assert.equal(witness.reason, 'inspected_bytes_changed_before_publication')
    assert.deepEqual(witness.stale_paths, ['app.ts'])
    // User-owned bytes remain on disk; the witness never edits them.
    assert.equal(hashFinalRevisionFile(root, 'app.ts'), hash('export const value = 2\n'))
  } finally {
    cleanup()
  }
})

test('a write after the required green verifier is stale (Deep late-write)', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'file_write', target: 'app.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test', exit_code: 0 },
      { tool: 'file_write', target: 'app.ts', exit_code: 0 },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
    assert.equal(witness.reason, 'mutation_after_required_verifier')
    assert.deepEqual(witness.stale_paths, ['app.ts'])
    assert.deepEqual(untestedPathsAfterLastGreenVerifier(log), ['app.ts'])
  } finally {
    cleanup()
  }
})

test('matching no-late-write control reaches verified completion', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'file_write', target: 'app.ts', exit_code: 0 },
      { tool: 'test_run', target: 'npm test', exit_code: 0 },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
    assert.equal(witness.verified_against, 'required_verifier')
    assert.deepEqual(witness.stale_paths, [])
  } finally {
    cleanup()
  }
})

test('read-only shell inspection after the verifier does not fake a late write', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'shell_exec', target: 'npm test', exit_code: 0 },
      { tool: 'shell_exec', target: 'git rev-parse HEAD', exit_code: 0 },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
  } finally {
    cleanup()
  }
})

test('missing required verifier is unverified, never verified', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'file_write', target: 'app.ts', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_missing')
  } finally {
    cleanup()
  }
})

test('host-bound verifier revision mismatch is stale', () => {
  const { root, cleanup } = fixture()
  try {
    const bound = {
      schema_version: 1 as const,
      contract: FINAL_REVISION_CONTRACT_VERSION,
      scope: { kind: 'files' as const, paths: ['app.ts'] },
      git_commit_hash: null,
      composite_tree_hash: '0'.repeat(64),
      captured_at: 1,
    }
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'test_run', target: 'npm test', exit_code: 0 }],
      requiredVerifierCommands: ['npm test'],
      verifierBoundRevision: bound,
    })
    assert.equal(witness.status, 'stale')
    assert.equal(witness.reason, 'final_revision_changed_after_verifier')
  } finally {
    cleanup()
  }
})

test('a host-proven no-op write after the verifier does not invalidate proof', () => {
  const { root, cleanup } = fixture()
  try {
    const log = [
      { tool: 'test_run', target: 'npm test', exit_code: 0 },
      { tool: 'file_write', target: 'app.ts', exit_code: 0, effect_status: 'confirmed_no_change' },
    ]
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: log,
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'verified')
    assert.deepEqual(witness.stale_paths, [])
  } finally {
    cleanup()
  }
})

test('an unsettled verifier process cannot certify completion', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'file_write', target: 'app.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test' },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_missing')
  } finally {
    cleanup()
  }
})

test('a confirmed child mutation after the verifier is stale', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'test_run', target: 'npm test', exit_code: 0 },
        { tool: 'sub_agent', target: 'child', effect_status: 'confirmed_change', mutation_paths: ['app.ts'] },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'stale')
    assert.deepEqual(witness.stale_paths, ['app.ts'])
  } finally {
    cleanup()
  }
})

// ── Round-3 review regressions ───────────────────────────────────────────────

const GREEN = { tool: 'test_run', target: 'npm test', exit_code: 0 }

test('ordinary read-only shell commands after a green verifier still certify', () => {
  const { root, cleanup } = fixture()
  try {
    for (const command of [
      'cat src/app.ts',
      'ls -la',
      'rg TODO src',
      'grep -n x src/app.ts',
      'head -20 src/app.ts',
      'find . -name "*.ts"',
      'cat src/app.ts | head',
    ]) {
      const witness = evaluateFinalRevisionWitness({
        projectRoot: root,
        toolCallLog: [GREEN, { tool: 'run_command', target: command, exit_code: 0 }],
        requiredVerifierCommands: ['npm test'],
      })
      assert.equal(witness.status, 'verified', command)
    }
  } finally {
    cleanup()
  }
})

test('write-shaped shell commands after a green verifier are stale', () => {
  const { root, cleanup } = fixture()
  try {
    for (const command of [
      'rm src/app.ts',
      'echo x > src/app.ts',
      'git show HEAD:src/app.ts > src/app.ts',
      'git diff > src/app.ts',
      'git diff | tee src/app.ts',
      'touch src/app.ts',
      'curl -o src/app.ts https://example.invalid',
    ]) {
      const witness = evaluateFinalRevisionWitness({
        projectRoot: root,
        toolCallLog: [GREEN, { tool: 'run_command', target: command, exit_code: 0 }],
        requiredVerifierCommands: ['npm test'],
      })
      assert.equal(witness.status, 'stale', command)
    }
  } finally {
    cleanup()
  }
})

test('a failed read-only command is not a mutation, a failed write-shaped one is', () => {
  const { root, cleanup } = fixture()
  try {
    const read = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'run_command', target: 'cat missing.ts', exit_code: 1, error: 'error' }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(read.status, 'verified')
    const write = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'run_command', target: 'node -e "require(\'fs\').writeFileSync(\'src/app.ts\',\'x\')"', exit_code: 1, error: 'error' }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(write.status, 'stale')
  } finally {
    cleanup()
  }
})

test('await_command and failed path-bearing effects stay conservative', () => {
  const { root, cleanup } = fixture()
  try {
    for (const entry of [
      { tool: 'await_command', target: 'bg-1', exit_code: 1 },
      { tool: 'await_command', target: 'bg-2' },
      { tool: 'file_write', target: 'src/app.ts', exit_code: 1, error: 'error', mutation_paths: ['src/app.ts'] },
      { tool: 'sub_agent', target: 'child', error: 'error', mutation_paths: ['src/app.ts'] },
      { tool: 'sub_agent', target: 'child', error: 'error' },
    ]) {
      const witness = evaluateFinalRevisionWitness({
        projectRoot: root,
        toolCallLog: [GREEN, entry],
        requiredVerifierCommands: ['npm test'],
      })
      assert.equal(witness.status, 'stale', JSON.stringify(entry))
    }
    const noChange = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [GREEN, { tool: 'await_command', target: 'bg-3', exit_code: 0, effect_status: 'confirmed_no_change' }],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(noChange.status, 'verified')
  } finally {
    cleanup()
  }
})

test('session-bound verifier commands use the same authority as the gate', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'run_command', target: 'gradle test', exit_code: 0 }],
      requiredVerifierCommands: ['gradle test'],
    })
    assert.equal(witness.status, 'verified')
    assert.equal(witness.verified_against, 'required_verifier')
  } finally {
    cleanup()
  }
})

test('absolute in-root reads are current; outside and symlinked credential reads are not', () => {
  const { root, cleanup } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'babel-final-revision-outside-'))
  try {
    writeFileSync(join(outside, '.env'), 'SYNTHETIC\n')
    writeFileSync(join(root, 'notes.txt'), 'inside\n')
    symlinkSync(join(outside, '.env'), join(root, 'linked-secret.txt'))
    const absolute = join(root, 'app.ts')
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'read_file', target: absolute, exit_code: 0, read_revision_hash: hash('export const value = 1\n') }],
    })
    assert.equal(witness.status, 'verified')
    assert.equal(hashFinalRevisionFile(root, join(outside, '.env')), null)
    assert.equal(hashFinalRevisionFile(root, join(root, '..', 'escape.txt')), null)
    assert.equal(hashFinalRevisionFile(root, 'linked-secret.txt'), null)
    assert.equal(hashFinalRevisionFile(root, 'notes.txt'), hash('inside\n'))
  } finally {
    cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('raw-byte hashing handles non-UTF8 and rejects oversized proof files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-bytes-'))
  try {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41])
    writeFileSync(join(root, 'binary.dat'), bytes)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(hashFinalRevisionFile(root, 'binary.dat'), expected)
    const large = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
    writeFileSync(join(root, 'large.bin'), large)
    assert.equal(hashFinalRevisionFile(root, 'large.bin'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a simulated verifier is not green proof', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'file_write', target: 'app.ts', exit_code: 0 },
        { tool: 'test_run', target: 'npm test', exit_code: 0, simulated: true, processExecuted: false },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_missing')
  } finally {
    cleanup()
  }
})

test('a later red required verifier is never certified by an earlier green', () => {
  const { root, cleanup } = fixture()
  try {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [
        { tool: 'test_run', target: 'npm test', exit_code: 0 },
        { tool: 'test_run', target: 'npm test', exit_code: 1 },
      ],
      requiredVerifierCommands: ['npm test'],
    })
    assert.equal(witness.status, 'unverified')
    assert.equal(witness.reason, 'required_verifier_red_after_green')
  } finally {
    cleanup()
  }
})

// ── Round-4 review regressions ──────────────────────────────────────────────

const G = { tool: 'test_run', target: 'npm test', exit_code: 0 }

function witnessFor(command: string) {
  return evaluateFinalRevisionWitness({
    projectRoot: '/tmp',
    toolCallLog: [G, { tool: 'run_command', target: command, exit_code: 0 }],
    requiredVerifierCommands: ['npm test'],
  })
}

test('option-level writes of allowlisted binaries are mutations', () => {
  for (const command of [
    'rg --pre=./pre.sh pattern s.txt',
    'git diff --output=diff-out.txt',
    'git log --output=x',
    'git show --output=x',
    'find . -fprint0 out.txt',
    'find . -fprintf out.txt %p',
    'tree -o out.txt',
    'sort -oout.txt',
    'file -C -m magic',
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
})

test('shell substitution and unsafe separators are mutations', () => {
  for (const command of [
    'cat $(rm out.txt)',
    'cat `rm out.txt`',
    'cat <(rm out.txt)',
    'cat a & rm b',
    'cat a\nrm b',
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
})

test('adversarial read-only options stay read-only', () => {
  for (const command of [
    'grep -o x src/app.ts',
    'grep -f pat src/app.ts',
    'rg --json pattern',
    'cat -A src/app.ts',
    'wc -l src/app.ts',
    'sed -n 1,10p src/app.ts',
    'head -20 src/app.ts',
    'tail -20 src/app.ts',
    'uniq -f 2 src/app.ts',
  ]) {
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})

test('common read-only inspection shapes certify after a green verifier', () => {
  for (const command of [
    'git rev-parse HEAD',
    'git branch --show-current',
    'git describe --tags',
    'git -c core.fsmonitor=false blame --no-textconv src/app.ts',
    'git -c core.fsmonitor=false --no-pager grep TODO',
    'git config --get user.name',
    'git config --file .git/config --get user.name',
    'git stash list',
    'git worktree list',
    'git tag -l',
    'find . -name "*.ts" | xargs grep TODO',
    'find . -name "*.ts" | xargs wc -l',
    'cat src/app.ts | sed -n 1,10p',
    'cat src/app.ts | less',
    'node --version',
  ]) {
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})

test('git write forms remain mutations', () => {
  for (const command of [
    'git config --set user.name x',
    'git config user.name x',
    'git help status',
    'git blame --contents=/tmp/read-exposure file',
    'git stash push',
    'git tag v1',
    'git branch new-branch',
    'git diff --output=src/app.ts',
    'sed -i s/a/b/ src/app.ts',
    'node script.js',
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
})

test('cross-form gradle and gradlew requirements recognize each other', () => {
  for (const [required, actual] of [
    ['gradle test', './gradlew test'],
    ['./gradlew test', 'gradle test'],
  ] as const) {
    const witness = evaluateFinalRevisionWitness({
      projectRoot: '/tmp',
      toolCallLog: [{ tool: 'shell_exec', target: actual, exit_code: 0 }],
      requiredVerifierCommands: [required],
    })
    assert.equal(witness.status, 'verified', `${required} <- ${actual}`)
  }
  const unrelated = evaluateFinalRevisionWitness({
    projectRoot: '/tmp',
    toolCallLog: [{ tool: 'shell_exec', target: 'echo hi', exit_code: 0 }],
    requiredVerifierCommands: ['gradle test'],
  })
  assert.equal(unrelated.status, 'unverified')
  assert.equal(unrelated.reason, 'required_verifier_missing')
})

test('oversized inspected bytes report unproven, not changed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-oversize-'))
  try {
    writeFileSync(join(root, 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))
    const witness = evaluateFinalRevisionWitness({
      projectRoot: root,
      toolCallLog: [{ tool: 'read_file', target: 'large.bin', exit_code: 0, read_revision_hash: 'a'.repeat(64) }],
    })
    assert.equal(witness.status, 'unavailable')
    assert.equal(witness.reason, 'inspected_bytes_unproven')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat final-revision requirement opts out only for ambient read-only', () => {
  assert.equal(chatFinalRevisionRequired({ ambientReadOnly: false, hasProjectRoot: true }), true)
  assert.equal(chatFinalRevisionRequired({ ambientReadOnly: true, hasProjectRoot: true }), false)
  assert.equal(chatFinalRevisionRequired({ ambientReadOnly: false, hasProjectRoot: false }), false)
})

// ── Round-5 adversarial corpus and proven execution vectors ─────────────────

const GIT_DENIALS = [
  '-O./pager.sh',
  '--open-files-in-pager=./pager.sh',
  '--textconv',
  '--filters',
  '--ext-diff',
  '--output=out.txt',
  '--show-signature',
  '--paginate',
  '--exec-path=/tmp',
]

test('every read subcommand × exec/write denial classifies as a mutation', () => {
  for (const subcommand of GIT_READ_ONLY_SUBCOMMANDS) {
    for (const denial of GIT_DENIALS) {
      const command = `git ${subcommand} ${denial}`
      assert.equal(witnessFor(command).status, 'stale', command)
    }
  }
})

test('git forbidden globals and inline config deny even before the subcommand', () => {
  for (const command of [
    'git -c diff.external=./x status',
    'git --paginate log',
    'git --exec-path=/tmp status',
    'git --git-dir=.git status',
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
})

test('proven host execution vectors classify as mutations', () => {
  for (const command of [
    'git grep -O./pager.sh -- needle',
    'git cat-file --filters HEAD:file.txt',
    'git show --textconv HEAD',
    'git diff --textconv',
    'git log --textconv',
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
})

test('sed write and execute families classify as mutations', () => {
  for (const command of [
    "sed '1w out' file",
    "sed '1,2w out' file",
    "sed 's/a/b/w out' file",
    "sed -e '1w out' file",
    'sed -f script.sed file',
    "sed '1e touch out' file",
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
})

test('common read flags and read-only options still certify', () => {
  for (const command of [
    'git -c core.fsmonitor=false status -sb',
    'git -c core.fsmonitor=false status -uno',
    'git branch -av',
    'git tag -n5',
    'git config --get user.name',
    'grep -o x src/app.ts',
    'rg --json pattern',
    'cat -A src/app.ts',
    'wc -l src/app.ts',
    'head -20 src/app.ts',
    'tail -20 src/app.ts',
    'uniq -f 2 src/app.ts',
    'sed -n 1,10p src/app.ts',
    'sed -n "s/a/b/g" src/app.ts',
  ]) {
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})


// ── Round-6 config-capability and false-block regressions ───────────────────

const GIT_PROBES: Readonly<Record<string, string>> = {
  status: 'git status', diff: 'git diff', log: 'git log', show: 'git show',
  blame: 'git blame file', grep: 'git grep TODO', 'cat-file': 'git cat-file -p HEAD:file',
  'rev-parse': 'git rev-parse HEAD', 'rev-list': 'git rev-list HEAD',
  'ls-files': 'git ls-files', 'ls-tree': 'git ls-tree HEAD', shortlog: 'git shortlog',
  reflog: 'git reflog show', whatchanged: 'git whatchanged', 'merge-base': 'git merge-base HEAD HEAD',
  'name-rev': 'git name-rev HEAD', 'check-ignore': 'git check-ignore file',
  'check-attr': 'git check-attr x file', var: 'git var GIT_AUTHOR_IDENT',
  'show-ref': 'git show-ref', 'for-each-ref': 'git for-each-ref',
  'count-objects': 'git count-objects', fsck: 'git fsck', version: 'git version',
  cherry: 'git cherry', 'range-diff': 'git range-diff A...B A...C',
  branch: 'git branch --show-current', tag: 'git tag -l', stash: 'git stash list',
  worktree: 'git worktree list', remote: 'git remote -v', submodule: 'git submodule status',
  config: 'git config --get user.name', notes: 'git notes list', describe: 'git describe --tags',
}

test('denial corpus is derived from the exported denial structure', () => {
  const probes = GIT_EXEC_WRITE_DENIAL_PROBES.filter(probe =>
    GIT_EXEC_WRITE_DENIALS.some(pattern => pattern.test(probe)))
  assert.equal(probes.length, GIT_EXEC_WRITE_DENIAL_PROBES.length)
  for (const pattern of GIT_EXEC_WRITE_DENIALS) {
    assert.ok(GIT_EXEC_WRITE_DENIAL_PROBES.some(probe => pattern.test(probe)), String(pattern))
  }
  for (const subcommand of GIT_READ_ONLY_SUBCOMMANDS) {
    for (const denial of probes) {
      const command = `git ${subcommand} ${denial}`
      assert.equal(witnessFor(command).status, 'stale', command)
    }
  }
})

test('config-capability corpus covers every proof-table subcommand', () => {
  assert.deepEqual([...GIT_CONFIG_CAPABLE_SUBCOMMANDS].sort(), ['blame', 'diff', 'grep', 'log', 'range-diff', 'reflog', 'show', 'status', 'whatchanged'])
  for (const subcommand of GIT_READ_ONLY_SUBCOMMANDS) {
    const probe = GIT_PROBES[subcommand]
    assert.ok(probe, `missing probe for ${subcommand}`)
    assert.equal(gitCommandProofReadOnly(probe), true, probe)
    const capability = gitConfigCapability(subcommand)
    const unproven = gitConfigEffectUnproven(probe)
    if (unproven) {
      assert.equal(capability, 'config_capable', probe)
      const witness = witnessFor(probe)
      assert.equal(witness.status, 'unverified', probe)
      assert.match(witness.reason ?? '', /^effect_unproven:config_capable_git/, probe)
    } else {
      assert.equal(witnessFor(probe).status, 'verified', probe)
    }
  }
})

test('hardened config-capable invocations restore verified proof', () => {
  for (const command of [
    'git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv',
    'git -c core.fsmonitor=false --no-pager log --no-ext-diff --no-textconv',
    'git -c core.fsmonitor=false --no-pager show --no-ext-diff --no-textconv',
    'git -c core.fsmonitor=false --no-pager whatchanged --no-ext-diff --no-textconv',
    'git -c core.fsmonitor=false --no-pager status',
    'git -c core.fsmonitor=false --no-pager grep TODO',
    'git -c core.fsmonitor=false blame --no-textconv file',
    'git reflog show --format=%H',
  ]) {
    assert.equal(gitConfigEffectUnproven(command), false, command)
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})

test('gpg format atoms and incomplete grep hardening stay effect-unproven', () => {
  for (const command of [
    'git reflog --format=%GG',
    'git log --format=%GG',
    'git -c core.fsmonitor=false --no-pager log --no-ext-diff --no-textconv --format=%GG',
    'git --no-pager grep TODO',
  ]) {
    const witness = witnessFor(command)
    assert.equal(witness.status, 'unverified', command)
    assert.match(witness.reason ?? '', /^effect_unproven:/, command)
  }
  for (const command of [
    'git -c core.fsmonitor=false --no-pager log --no-ext-diff --no-textconv --format=%H',
    'git -c core.fsmonitor=false --no-pager grep TODO',
  ]) {
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})

test('inverted table false-block shapes are admitted as unverified, not stale', () => {
  for (const command of [
    'git diff --no-renames --text -Sfoo --patience --histogram --summary --minimal --ignore-submodules --compact-summary --dirstat',
    'git log -U3 --unified=3 -w --ignore-all-space',
    'git grep -A3 -B3 -C3 -m1 -q -o -h TODO',
    'git blame -w -M -C -e -f file',
  ]) {
    const witness = witnessFor(command)
    assert.equal(witness.status, 'unverified', command)
    assert.match(witness.reason ?? '', /^effect_unproven:/, command)
  }
  for (const command of [
    'sed "y/a/b/" file',
    "sed '1a text' file",
    "sed -n '/start/,/end/p' file",
  ]) {
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})

test('two-way decoder cross-check for proof-table reads', async () => {
  const { decodeCommand } = await import('./commandDecoder.js')
  const documentedWriteDivergence = new Set(['branch', 'config', 'stash', 'worktree'])
  for (const subcommand of GIT_READ_ONLY_SUBCOMMANDS) {
    const probe = GIT_PROBES[subcommand]
    if (!probe) continue
    const tableRead = gitCommandProofReadOnly(probe)
    const semantic = decodeCommand(probe).semantic
    assert.equal(tableRead, true, probe)
    if (gitConfigCapability(subcommand) === 'mechanical') {
      assert.equal(witnessFor(probe).status, 'verified', probe)
    }
    if (semantic === 'read_local') assert.equal(tableRead, true, probe)
    if (semantic === 'write_local_reversible' || semantic === 'infrastructure_mutation') {
      assert.ok(documentedWriteDivergence.has(subcommand), `${subcommand}: ${semantic}`)
    }
    if (documentedWriteDivergence.has(subcommand)) {
      assert.ok(semantic === 'write_local_reversible' || semantic === 'infrastructure_mutation', subcommand)
    }
  }
})

test('round-4/5/6 probe equivalence: 20 execution vectors stale, 27 read shapes never stale', () => {
  const staleVectors = [
    'rg --pre=./pre.sh pattern s.txt',
    'git diff --output=diff-out.txt',
    'git log --output=x',
    'git show --output=x',
    'find . -fprint0 out.txt',
    'tree -o out.txt',
    'sort -oout.txt',
    'file -C -m magic',
    'cat $(rm out.txt)',
    'cat `rm out.txt`',
    'cat <(rm out.txt)',
    'cat a & rm b',
    'cat a\nrm b',
    'git grep -O./pager.sh -- needle',
    'git cat-file --filters HEAD:file.txt',
    'git show --textconv HEAD',
    'git diff --textconv',
    'git log --textconv',
    'git -c diff.external=./x status',
    'git --paginate log',
  ]
  assert.equal(staleVectors.length, 20)
  for (const command of staleVectors) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }

  const readShapes = [
    'git rev-parse HEAD',
    'git branch --show-current',
    'git describe --tags',
    'git -c core.fsmonitor=false blame --no-textconv src/app.ts',
    'git -c core.fsmonitor=false --no-pager grep TODO',
    'git config --get user.name',
    'git stash list',
    'git worktree list',
    'git tag -l',
    'find . -name "*.ts" | xargs grep TODO',
    'find . -name "*.ts" | xargs wc -l',
    'cat src/app.ts | sed -n 1,10p',
    'cat src/app.ts | less',
    'node --version',
    'git log --oneline --graph --stat -n 5',
    'git log -20',
    'git show -s',
    'git status -sb',
    'git status -uno',
    'git branch -av',
    'git diff --stat',
    'git tag -n5',
    'git diff --no-renames --text -Sfoo --patience --histogram --summary --minimal --ignore-submodules --compact-summary --dirstat',
    'git log -U3 --unified=3 -w --ignore-all-space',
    'git blame -w -M -C -e -f src/app.ts',
    'git grep -A3 -B3 -C3 -m1 -q -o -h TODO',
    'sed "y/a/b/" file',
  ]
  assert.equal(readShapes.length, 27)
  for (const command of readShapes) {
    const status = witnessFor(command).status
    assert.notEqual(status, 'stale', command)
  }
})

test('invalid attached -c forms and remote show cannot verify', () => {
  for (const command of [
    'git -c=core.fsmonitor=false status',
    'git -ccore.fsmonitor=false status',
    'git remote show origin',
  ]) {
    assert.equal(witnessFor(command).status, 'stale', command)
  }
  for (const command of ['git remote -v', 'git remote get-url origin']) {
    assert.equal(witnessFor(command).status, 'verified', command)
  }
})
