/** RT-09 — workspace change snapshots must not advertise changes with no diff. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildReadOnlyGitArgs,
  buildReadOnlyGitEnvironment,
  classifyGitTermination,
  collectWorkspaceChanges,
  isSafeRacyIndexStamp,
  sanitizeNoIndexDiff,
  WORKSPACE_CHANGE_CONFIG_SENTINEL_KEY,
  WORKSPACE_CHANGE_ISOLATED_SENTINEL_KEY,
} from './workspaceChanges.js'

let gitRequired = false

function requireGit(): void {
  if (gitRequired) return
  const probe = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(probe.status, 0, 'git must be available for workspace inspection tests')
  gitRequired = true
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr ?? result.error?.message ?? ''}`)
  return result.stdout.trim()
}

function removeTree(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

interface MarkerHelper {
  helper: string
  marker: string
  runDirectly: () => void
}

/**
 * Test-only inert helper: it only writes one marker file. It is never a
 * vulnerability payload; the direct execution is the positive control.
 */
function createMarkerHelper(root: string, name: string): MarkerHelper {
  const marker = join(root, `${name}.executed`)
  if (process.platform === 'win32') {
    const helper = join(root, `${name}.cmd`)
    writeFileSync(helper, `@echo off\r\n> "${marker}" echo executed\r\nexit /b 0\r\n`)
    return {
      helper,
      marker,
      runDirectly: () => {
        const result = spawnSync(`"${helper}"`, {
          cwd: root,
          shell: true,
          encoding: 'utf8',
          windowsHide: true,
        })
        assert.equal(result.status, 0, `helper positive control: ${result.stderr ?? result.error?.message ?? ''}`)
      },
    }
  }
  const helper = join(root, `${name}.sh`)
  writeFileSync(helper, `#!/bin/sh\nprintf executed > ${shellQuote(marker)}\nexit 0\n`)
  chmodSync(helper, 0o700)
  return {
    helper,
    marker,
    runDirectly: () => {
      const result = spawnSync(helper, [], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      })
      assert.equal(result.status, 0, `helper positive control: ${result.stderr ?? result.error?.message ?? ''}`)
    },
  }
}

test('read-only Git invocation clears inherited helper controls and disables execution features', () => {
  const emptyConfig = join(tmpdir(), 'fixture-empty-gitconfig')
  const systemConfig = join(tmpdir(), 'fixture-system-gitconfig')
  const env = buildReadOnlyGitEnvironment(
    {
      PATH: '/usr/bin',
      GIT_CONFIG_GLOBAL: '/fixture/untrusted.gitconfig',
      GIT_CONFIG_SYSTEM: '/fixture/untrusted-system.gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/fixture/fsmonitor',
      GIT_EXTERNAL_DIFF: '/fixture/external-diff',
      ANTHROPIC_API_KEY: 'synthetic-secret',
      LANG: 'C.UTF-8',
    },
    emptyConfig,
    systemConfig,
  )
  const args = buildReadOnlyGitArgs(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.'])

  assert.equal(env['GIT_CONFIG_GLOBAL'], emptyConfig)
  assert.equal(env['GIT_CONFIG_SYSTEM'], systemConfig)
  assert.equal(env['GIT_CONFIG_NOSYSTEM'], '1')
  assert.equal(env['GIT_OPTIONAL_LOCKS'], '0')
  assert.equal(env['GIT_EXTERNAL_DIFF'], undefined)
  assert.equal(env['GIT_CONFIG_COUNT'], undefined)
  assert.equal(env['GIT_CONFIG_KEY_0'], undefined)
  assert.equal(env['ANTHROPIC_API_KEY'], undefined)
  assert.equal(env['PATH'], '/usr/bin')
  assert.equal(env['LANG'], 'C.UTF-8')
  assert.equal(args.includes('core.fsmonitor=false'), true)
  assert.equal(args.includes('diff.external='), true)
  assert.equal(args.includes('--no-ext-diff'), true)
  assert.equal(args.includes('--no-textconv'), true)
})

test('repository clean/process/smudge filters fail closed before status or diff', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-git-filter-'))
  try {
    git(root, ['init', '--quiet'])
    writeFileSync(join(root, 'tracked.txt'), 'fixture\n')
    git(root, ['add', '.'])
    git(root, ['config', 'filter.fixture.process', '/fixture/unsafe-helper'])

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /filter configuration is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('RT-09: staged and untracked changes are present in the returned diff', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-changes-'))
  try {
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'tracked.txt'), 'tracked v1\n')
    writeFileSync(join(root, 'staged.txt'), 'staged v1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])

    writeFileSync(join(root, 'tracked.txt'), 'tracked v2 unstaged\n')
    writeFileSync(join(root, 'staged.txt'), 'staged v2 staged\n')
    git(root, ['add', 'staged.txt'])
    writeFileSync(join(root, 'untracked.txt'), 'new untracked file\n')

    const snapshot = collectWorkspaceChanges(root)
    assert.equal(snapshot.available, true)
    assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ['staged.txt', 'tracked.txt', 'untracked.txt'])
    assert.match(snapshot.diff, /staged v2 staged/)
    assert.match(snapshot.diff, /tracked v2 unstaged/)
    assert.match(snapshot.diff, /# Untracked file: "untracked\.txt"/)
    assert.match(snapshot.diff, /new untracked file/)
  } finally {
    removeTree(root)
  }
})

test('Windows CI sentinel: a marker helper executes directly but not during protected inspection', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-git-helper-'))
  try {
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'tracked.txt'), 'before\n')
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=fixture\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])
    writeFileSync(join(root, 'tracked.txt'), 'after\n')

    const helper = createMarkerHelper(root, 'fixture-helper')
    helper.runDirectly()
    assert.equal(existsSync(helper.marker), true, 'positive control helper must write its marker')
    rmSync(helper.marker, { force: true })

    const helperPath = helper.helper.replace(/\\/g, '/')
    git(root, ['config', 'diff.external', helperPath])
    git(root, ['config', 'diff.fixture.textconv', helperPath])
    git(root, ['config', 'core.fsmonitor', helperPath])

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.equal(
      existsSync(helper.marker),
      false,
      'configured Git helpers must remain inert during read-only inspection',
    )
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed when diff output exceeds its byte budget', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-large-diff-'))
  try {
    git(root, ['init', '--quiet'])
    // This budget is enforced before any subprocess: the untracked file is
    // rejected by its copied byte count. The subprocess buffer limit itself is
    // covered by the tracked-diff control below.
    writeFileSync(join(root, 'large-untracked.txt'), `${'x'.repeat(1_050_000)}\n`)

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.equal(snapshot.diff, '')
    assert.deepEqual(snapshot.files, [])
    assert.match(snapshot.reason ?? '', /output limit|buffer|ENOBUFS/i)
  } finally {
    removeTree(root)
  }
})

test('termination classification separates a full buffer from an elapsed deadline', () => {
  // Node kills a maxBuffer overrun with SIGTERM, the signal its own timeout
  // kill uses, so the bare signal must never be read as an elapsed deadline.
  for (const deadlineElapsed of [false, true]) {
    assert.deepEqual(
      classifyGitTermination({ errorCode: 'ENOBUFS', signal: 'SIGTERM', deadlineElapsed }),
      { outputLimit: true, timedOut: false },
    )
  }
  assert.deepEqual(
    classifyGitTermination({ errorCode: 'ETIMEDOUT', signal: 'SIGTERM', deadlineElapsed: true }),
    { outputLimit: false, timedOut: true },
  )
  // Ordinary termination signals are only a timeout once the explicit deadline
  // this process set has actually elapsed.
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    assert.deepEqual(
      classifyGitTermination({ errorCode: undefined, signal, deadlineElapsed: false }),
      { outputLimit: false, timedOut: false },
    )
    assert.deepEqual(
      classifyGitTermination({ errorCode: undefined, signal, deadlineElapsed: true }),
      { outputLimit: false, timedOut: true },
    )
  }
  assert.deepEqual(
    classifyGitTermination({ errorCode: 'ENOENT', signal: null, deadlineElapsed: true }),
    { outputLimit: false, timedOut: false },
  )
  assert.deepEqual(classifyGitTermination({ errorCode: undefined, signal: null, deadlineElapsed: false }), {
    outputLimit: false,
    timedOut: false,
  })
})

test('harmless subprocess control: a full buffer is an output limit even though Node signals it', () => {
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("y".repeat(4_000_000))'], {
    encoding: 'utf8',
    maxBuffer: 1_000_000,
    windowsHide: true,
  })
  const errorCode = (probe.error as NodeJS.ErrnoException | undefined)?.code
  assert.equal(errorCode, 'ENOBUFS', 'the control must genuinely cross the subprocess output limit')
  assert.equal(typeof probe.stdout, 'string')
  assert.deepEqual(classifyGitTermination({ errorCode, signal: probe.signal, deadlineElapsed: false }), {
    outputLimit: true,
    timedOut: false,
  })
})

test('tracked diff over the subprocess buffer limit fails closed as an output limit, never a timeout', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-tracked-buffer-'))
  try {
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    // Ordinary tracked text. The second revision is a different size (more
    // lines), so Git detects it from the stat alone and the ~2.3 MB one-file
    // diff genuinely overruns the subprocess buffer limit regardless of
    // filesystem timestamp granularity.
    const revision = (marker: string, lines: number): string =>
      `${Array.from({ length: lines }, (_, index) => `${marker} ${index} ${'.'.repeat(680)}`).join('\n')}\n`
    writeFileSync(join(root, 'tracked.txt'), revision('version one', 900))
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])
    writeFileSync(join(root, 'tracked.txt'), revision('version two', 2_400))

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.equal(snapshot.reason, 'workspace diff output limit exceeded')
    assert.equal((snapshot.reason ?? '').includes(root), false)
    assert.equal(/timed out/i.test(snapshot.reason ?? ''), false)
  } finally {
    removeTree(root)
  }
})

test('isolated index copy keeps racy-clean re-checks for a same-size edit', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-racy-index-'))
  try {
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    // A same-timestamp add leaves the index racy against its own entry. Pin
    // that state deterministically instead of sleeping: the index file and the
    // edited file share the entry mtime, and both revisions have equal length.
    const pinned = new Date(1_700_000_000_000)
    writeFileSync(join(root, 'tracked.txt'), 'version one\nsame byte count\n')
    utimesSync(join(root, 'tracked.txt'), pinned, pinned)
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])
    utimesSync(join(root, '.git', 'index'), pinned, pinned)
    writeFileSync(join(root, 'tracked.txt'), 'version two\nsame byte count\n')
    utimesSync(join(root, 'tracked.txt'), pinned, pinned)

    // The source checkout re-checks the racy entry and sees the edit; the
    // read-only inspection must reproduce that, not trust the stale stat.
    assert.equal(git(root, ['--no-optional-locks', 'status', '--porcelain=v1']), 'M tracked.txt')

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ['tracked.txt'],
    )
    assert.match(snapshot.diff, /-version one/)
    assert.match(snapshot.diff, /\+version two/)
  } finally {
    removeTree(root)
  }
})

test('private index stamp predicate rejects a rounded-up timestamp', () => {
  // The bound is the floored source second; anything after it would let Git
  // treat a racy entry as definitely clean.
  assert.equal(isSafeRacyIndexStamp(1_700_000_000_000, 1_700_000_000), true)
  assert.equal(isSafeRacyIndexStamp(1_699_999_999_000, 1_700_000_000), true)
  assert.equal(isSafeRacyIndexStamp(1_700_000_000_500, 1_700_000_000), false)
  assert.equal(isSafeRacyIndexStamp(1_700_000_001_000, 1_700_000_000), false)
})

test('workspace inspection refuses a file list larger than its count budget', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-many-files-'))
  try {
    git(root, ['init', '--quiet'])
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(root, `untracked-${index}.txt`), 'fixture\n')
    }

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.equal(snapshot.diff, '')
    assert.deepEqual(snapshot.files, [])
    assert.match(snapshot.reason ?? '', /file limit/i)
  } finally {
    removeTree(root)
  }
})

test('RT-09 positive control: a clean workspace reports no files and no diff', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-clean-'))
  try {
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'tracked.txt'), 'tracked\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])

    const snapshot = collectWorkspaceChanges(root)
    assert.equal(snapshot.available, true)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
  } finally {
    removeTree(root)
  }
})

test('RT-09: a non-repository path is explicitly unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-norepo-'))
  try {
    const snapshot = collectWorkspaceChanges(root)
    assert.equal(snapshot.available, false)
    assert.ok(snapshot.reason)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection ignores repository-layer sentinel collisions', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-sentinel-'))
  try {
    git(root, ['init', '--quiet'])
    // Command-free collision markers. The sentinels are diagnostics for the
    // isolated execution boundary, not a preflight scan of this mutable layer.
    git(root, ['config', WORKSPACE_CHANGE_CONFIG_SENTINEL_KEY, 'poisoned'])
    git(root, ['config', WORKSPACE_CHANGE_ISOLATED_SENTINEL_KEY, 'poisoned'])

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
  } finally {
    removeTree(root)
  }
})

test('trusted Git resolution ignores inert absolute PATH entries', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-trusted-git-'))
  try {
    const repo = join(root, 'repo')
    const inertDir = join(root, 'inert-bin')
    mkdirSync(inertDir)
    // Inert, non-executable marker. It is not a helper and is never chmodded.
    writeFileSync(join(inertDir, process.platform === 'win32' ? 'git.exe' : 'git'), 'not an executable\n')
    git(root, ['init', '--quiet', repo])
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\n')

    const snapshot = collectWorkspaceChanges(repo, {
      env: { ...process.env, PATH: inertDir },
    })

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ['tracked.txt'],
    )
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for external object alternates', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-alternates-'))
  try {
    git(root, ['init', '--quiet'])
    const info = join(root, '.git', 'objects', 'info')
    mkdirSync(info, { recursive: true })
    writeFileSync(join(info, 'alternates'), `${join(root, 'outside-objects').replace(/\\/g, '/')}\n`)

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /object alternates are unsupported/i)
    assert.equal((snapshot.reason ?? '').includes(root), false)
    assert.equal((snapshot.reason ?? '').includes('fatal'), false)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for split index metadata', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-split-index-'))
  try {
    git(root, ['init', '--quiet'])
    writeFileSync(join(root, '.git', 'sharedindex.deadbeef'), '')

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /split index is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection preserves unusual path whitespace and unicode', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-paths-'))
  try {
    git(root, ['init', '--quiet'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'plain.txt'), 'plain v1\n')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])

    writeFileSync(join(root, 'plain.txt'), 'plain v2\n')
    writeFileSync(join(root, 'sp ace.txt'), 'spaced staged\n')
    git(root, ['add', 'sp ace.txt'])
    writeFileSync(join(root, 'two  spaces.txt'), 'double untracked\n')
    writeFileSync(join(root, 'café.txt'), 'unicode untracked\n')
    writeFileSync(join(root, 'empty untracked.txt'), '')
    writeFileSync(join(root, ' leading space.txt'), 'leading untracked\n')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.deepEqual(
      snapshot.files.map((file) => file.path).sort(),
      [
        'binary.dat',
        'café.txt',
        'empty untracked.txt',
        ' leading space.txt',
        'plain.txt',
        'sp ace.txt',
        'two  spaces.txt',
      ].sort(),
    )
    assert.match(snapshot.diff, /spaced staged/)
    assert.match(snapshot.diff, /double untracked/)
    assert.match(snapshot.diff, /unicode untracked/)
    assert.match(snapshot.diff, /leading untracked/)
    assert.match(snapshot.diff, /# Untracked file: "empty untracked\.txt"/)
    assert.match(snapshot.diff, /Binary files \/dev\/null and "binary\.dat" differ/)
    assert.equal(snapshot.diff.includes('/untracked/'), false)
    assert.equal(snapshot.diff.includes('repository.git'), false)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection bounds nested untracked files instead of collapsing directories', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-nested-files-'))
  try {
    git(root, ['init', '--quiet'])
    const nested = join(root, 'nested')
    mkdirSync(nested)
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(nested, `untracked-${index}.txt`), 'fixture\n')
    }

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.equal(snapshot.diff, '')
    assert.deepEqual(snapshot.files, [])
    assert.match(snapshot.reason ?? '', /untracked file limit|file limit/i)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for repository config includes', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-include-'))
  try {
    git(root, ['init', '--quiet'])
    const included = join(root, 'included.gitconfig')
    writeFileSync(included, '[babelWorkspaceInspection]\n\tincludedMarker = one\n')
    git(root, ['config', '--add', 'include.path', included.replace(/\\/g, '/')])
    assert.equal(git(root, ['config', '--get', 'babelWorkspaceInspection.includedMarker']), 'one')

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /include configuration is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for conditional repository config includes', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-conditional-'))
  try {
    git(root, ['init', '--quiet'])
    const included = join(root, 'conditional.gitconfig')
    writeFileSync(included, '[babelWorkspaceInspection]\n\tconditionalMarker = one\n')
    const branch = git(root, ['symbolic-ref', '--short', 'HEAD'])
    appendFileSync(
      join(root, '.git', 'config'),
      `[includeIf "onbranch:${branch}"]\n\tpath = ${included.replace(/\\/g, '/')}\n`,
    )
    assert.equal(git(root, ['config', '--get', 'babelWorkspaceInspection.conditionalMarker']), 'one')

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /include configuration is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for worktree-specific configuration', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-worktree-'))
  try {
    const main = join(root, 'main')
    const linked = join(root, 'linked')
    git(root, ['init', '--quiet', main])
    git(main, ['config', 'user.email', 'test@example.invalid'])
    git(main, ['config', 'user.name', 'Test'])
    writeFileSync(join(main, 'tracked.txt'), 'tracked\n')
    git(main, ['add', '.'])
    git(main, ['commit', '--quiet', '-m', 'initial'])
    git(main, ['config', 'extensions.worktreeConfig', 'true'])
    git(main, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'])
    git(linked, ['config', '--worktree', 'babelWorkspaceInspection.worktreeMarker', 'one'])
    assert.equal(git(linked, ['config', '--get', 'babelWorkspaceInspection.worktreeMarker']), 'one')
    assert.equal(
      existsSync(git(linked, ['rev-parse', '--git-path', 'config.worktree'])),
      true,
      'the worktree-specific layer must actually exist before the inspection',
    )

    const snapshot = collectWorkspaceChanges(linked)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /worktree-specific repository configuration is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection supports a validated linked worktree without worktree config', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-linked-'))
  try {
    const main = join(root, 'main')
    const linked = join(root, 'linked')
    git(root, ['init', '--quiet', main])
    git(main, ['config', 'user.email', 'test@example.invalid'])
    git(main, ['config', 'user.name', 'Test'])
    writeFileSync(join(main, 'tracked.txt'), 'tracked\n')
    git(main, ['add', '.'])
    git(main, ['commit', '--quiet', '-m', 'initial'])
    git(main, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'])
    writeFileSync(join(linked, 'tracked.txt'), 'linked change\n')

    const snapshot = collectWorkspaceChanges(linked)

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ['tracked.txt'],
    )
    assert.match(snapshot.diff, /linked change/)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection denies ordinary submodule metadata', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-submodule-'))
  try {
    const subrepo = join(root, 'subrepo')
    const main = join(root, 'main')
    git(root, ['init', '--quiet', subrepo])
    git(subrepo, ['config', 'user.email', 'test@example.invalid'])
    git(subrepo, ['config', 'user.name', 'Test'])
    writeFileSync(join(subrepo, 'nested.txt'), 'nested\n')
    git(subrepo, ['add', '.'])
    git(subrepo, ['commit', '--quiet', '-m', 'nested initial'])
    const nestedCommit = git(subrepo, ['rev-parse', 'HEAD'])
    git(root, ['init', '--quiet', main])
    git(main, ['config', 'user.email', 'test@example.invalid'])
    git(main, ['config', 'user.name', 'Test'])
    writeFileSync(join(main, 'tracked.txt'), 'tracked\n')
    git(main, ['add', '.'])
    git(main, ['commit', '--quiet', '-m', 'initial'])
    writeFileSync(join(main, '.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ../subrepo\n')
    git(main, ['add', '.gitmodules'])
    git(main, ['commit', '--quiet', '-m', 'submodule metadata'])
    git(main, ['update-index', '--add', '--cacheinfo', `160000,${nestedCommit},nested`])

    const snapshot = collectWorkspaceChanges(main)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /submodule state is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection denies a bare gitlink without .gitmodules', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-gitlink-'))
  try {
    const subrepo = join(root, 'subrepo')
    const main = join(root, 'main')
    git(root, ['init', '--quiet', subrepo])
    git(subrepo, ['config', 'user.email', 'test@example.invalid'])
    git(subrepo, ['config', 'user.name', 'Test'])
    writeFileSync(join(subrepo, 'nested.txt'), 'nested\n')
    git(subrepo, ['add', '.'])
    git(subrepo, ['commit', '--quiet', '-m', 'nested initial'])
    const nestedCommit = git(subrepo, ['rev-parse', 'HEAD'])
    git(root, ['init', '--quiet', main])
    git(main, ['config', 'user.email', 'test@example.invalid'])
    git(main, ['config', 'user.name', 'Test'])
    writeFileSync(join(main, 'tracked.txt'), 'tracked\n')
    git(main, ['add', '.'])
    git(main, ['commit', '--quiet', '-m', 'initial'])
    git(main, ['update-index', '--add', '--cacheinfo', `160000,${nestedCommit},nested`])

    const snapshot = collectWorkspaceChanges(main)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /submodule state is unsupported/i)
  } finally {
    removeTree(root)
  }
})

test('no-index header sanitization encodes control characters in every reconstructed position', () => {
  const controlPath = 'line\nbreak\tfile "quote" \\ ü.txt'
  const encoded = JSON.stringify(controlPath)
  const raw = [
    'diff --git a/dev/null b/C:/private/untracked/0',
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    '+++ b/C:/private/untracked/0',
    '@@ -0,0 +1 @@',
    '+body',
  ].join('\n')
  const sanitized = sanitizeNoIndexDiff(raw, controlPath)
  const lines = sanitized.split('\n')
  assert.equal(lines[0], `diff --git a/${encoded} b/${encoded}`)
  assert.equal(lines[4], `+++ b/${encoded}`)
  assert.equal(lines[6], '+body')
  assert.equal(sanitized.includes('C:/private/untracked/0'), false)

  const binary = [
    'diff --git a/dev/null b/snapshot',
    'new file mode 100644',
    'index 0000000..1234567',
    'Binary files /dev/null and b/snapshot differ',
  ].join('\n')
  const binarySanitized = sanitizeNoIndexDiff(binary, controlPath)
  assert.equal(binarySanitized.split('\n').at(-1), `Binary files /dev/null and ${encoded} differ`)
  assert.equal(binarySanitized.includes('snapshot'), false)

  if (process.platform !== 'win32') {
    const root = mkdtempSync(join(tmpdir(), 'babel-workspace-control-path-'))
    try {
      git(root, ['init', '--quiet'])
      writeFileSync(join(root, controlPath), 'control body\n')

      const snapshot = collectWorkspaceChanges(root)

      assert.equal(snapshot.available, true, snapshot.reason)
      assert.ok(snapshot.files.some((file) => file.path === controlPath))
      const header = snapshot.diff.split('\n').find((line) => line.startsWith('diff --git '))
      assert.equal(header, `diff --git a/${encoded} b/${encoded}`)
      assert.equal(snapshot.diff.includes('C:/private/untracked/0'), false)
      assert.equal(snapshot.diff.includes('repository.git'), false)
    } finally {
      removeTree(root)
    }
  }
})

test('workspace inspection denies hardlinked untracked leaves', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-hardlink-'))
  try {
    const repo = join(root, 'repo')
    git(root, ['init', '--quiet', repo])
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'outside\n')
    linkSync(outside, join(repo, 'untracked.txt'))

    const snapshot = collectWorkspaceChanges(repo)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /hardlinked untracked paths are unsupported/i)
    assert.equal((snapshot.reason ?? '').includes(root), false)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for an embedded Git checkout', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-embedded-'))
  try {
    git(root, ['init', '--quiet'])
    const embedded = join(root, 'embedded')
    git(root, ['init', '--quiet', embedded])
    writeFileSync(join(embedded, 'nested.txt'), 'nested\n')

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /not a regular in-scope file|embedded repositories are unsupported/i)
    assert.equal((snapshot.reason ?? '').includes(root), false)
  } finally {
    removeTree(root)
  }
})

test('workspace inspection fails closed for linked untracked paths', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-untracked-link-'))
  const link = join(root, 'linked')
  try {
    git(root, ['init', '--quiet'])
    const target = join(root, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'file.txt'), 'target\n')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

    const snapshot = collectWorkspaceChanges(root)

    assert.equal(snapshot.available, false)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
    assert.match(snapshot.reason ?? '', /not a regular in-scope file|embedded repositories are unsupported/i)
    assert.equal((snapshot.reason ?? '').includes(root), false)
  } finally {
    try {
      rmSync(link, { force: true })
    } catch {
      // Best-effort link cleanup.
    }
    removeTree(root)
  }
})

test('ambient Git configuration cannot replace the inspection boundary', () => {
  requireGit()
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-ambient-'))
  try {
    git(root, ['init', '--quiet'])
    // Outside the worktree so the ambient fixture is not itself a change.
    const ambient = join(root, '.git', 'ambient.gitconfig')
    writeFileSync(ambient, '[babelWorkspaceInspection]\n\tconfigBoundarySentinel = ambient\n')

    const snapshot = collectWorkspaceChanges(root, {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: ambient,
        GIT_CONFIG_SYSTEM: ambient,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: WORKSPACE_CHANGE_CONFIG_SENTINEL_KEY,
        GIT_CONFIG_VALUE_0: 'ambient',
      },
    })

    assert.equal(snapshot.available, true, snapshot.reason)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.diff, '')
  } finally {
    removeTree(root)
  }
})
