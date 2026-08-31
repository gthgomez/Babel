#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const repo = resolve(process.argv[process.argv.indexOf('--repo') + 1] ?? process.cwd())
const output = resolve(process.argv[process.argv.indexOf('--output') + 1] ?? join(repo, 'artifacts', 'repository-consolidation'))

function run(args, cwd = repo) {
  try {
    return { ok: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', status: 0 }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), status: error.status ?? null }
  }
}

function runGh(args) {
  try {
    return { ok: true, stdout: execFileSync('gh', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', status: 0 }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), status: error.status ?? null }
  }
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function json(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`)
}

function lines(value) {
  return value.split(/\r?\n/).filter(Boolean)
}

function slug(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90) || 'worktree'
}

function isCopyableUntracked(path) {
  const normalized = path.replaceAll('\\', '/')
  if (/^\.env(?:\.|$)/i.test(basename(normalized))) return false
  if (/(^|\/)(node_modules|dist|runs|artifacts|\.git)(\/|$)/i.test(normalized)) return false
  return /\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|ps1|yml|yaml|toml|txt|css|html)$/i.test(normalized)
}

function worktrees() {
  const result = run(['worktree', 'list', '--porcelain'])
  const parsed = []
  let current = null
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) parsed.push(current)
      current = { path: line.slice('worktree '.length) }
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7)
    else if (current && line === 'detached') current.detached = true
  }
  if (current) parsed.push(current)
  return parsed
}

function statusFor(worktree) {
  const status = run(['status', '--porcelain=v1', '--untracked-files=all'], worktree.path)
  const branch = run(['symbolic-ref', '--short', '-q', 'HEAD'], worktree.path)
  const head = run(['rev-parse', 'HEAD'], worktree.path)
  const ahead = run(['rev-list', '--count', 'origin/main..HEAD'], worktree.path)
  const behind = run(['rev-list', '--count', 'HEAD..origin/main'], worktree.path)
  const diff = run(['diff', '--binary'], worktree.path)
  const staged = run(['diff', '--cached', '--binary'], worktree.path)
  const untracked = run(['ls-files', '--others', '--exclude-standard'], worktree.path)
  const changed = run(['diff', '--name-only'], worktree.path)
  const stagedNames = run(['diff', '--cached', '--name-only'], worktree.path)
  const commitsAhead = run(['log', '--oneline', 'origin/main..HEAD'], worktree.path)
  return {
    path: worktree.path,
    registeredHead: worktree.head ?? null,
    branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : worktree.detached ? 'DETACHED' : null,
    head: head.ok ? head.stdout.trim() : null,
    status: status.stdout,
    statusError: status.ok ? null : status.stderr,
    trackedChanges: changed.stdout,
    stagedChanges: stagedNames.stdout,
    untrackedFiles: untracked.stdout,
    commitsAhead: commitsAhead.stdout,
    ahead: ahead.ok ? Number(ahead.stdout.trim() || 0) : null,
    behind: behind.ok ? Number(behind.stdout.trim() || 0) : null,
    diff: diff.stdout,
    stagedDiff: staged.stdout,
  }
}

const before = {
  capturedAt: new Date().toISOString(),
  repo,
  repoRoot: run(['rev-parse', '--show-toplevel']).stdout.trim(),
  remote: run(['remote', '-v']).stdout,
  status: run(['status', '--short', '--branch', '--untracked-files=all']).stdout,
  head: run(['rev-parse', 'HEAD']).stdout.trim(),
  originMain: run(['rev-parse', 'origin/main']).stdout.trim(),
  branch: run(['branch', '--show-current']).stdout.trim(),
  branches: run(['branch', '-vv']).stdout,
  remotes: run(['branch', '-r', '--format=%(refname:short) %(objectname)']).stdout,
  graph: run(['log', '--graph', '--decorate', '--oneline', '--all', '-n', '160']).stdout,
  stash: run(['stash', 'list', '--date=local']).stdout,
  worktreeList: run(['worktree', 'list', '--porcelain']).stdout,
  worktrees: worktrees(),
}

const worktreeStates = before.worktrees.map(statusFor)
const dirtyStates = worktreeStates.filter((state) => state.status.trim() || state.statusError)
const baseline = join(output, 'baseline')
mkdirSync(baseline, { recursive: true })
write(join(baseline, 'main.txt'), [
  `captured_at=${before.capturedAt}`,
  `repo=${before.repo}`,
  `repo_root=${before.repoRoot}`,
  `remote=${before.remote.trim()}`,
  `branch=${before.branch}`,
  `head=${before.head}`,
  `origin_main=${before.originMain}`,
  '',
  before.status,
].join('\n') + '\n')
write(join(baseline, 'branches.txt'), `${before.branches}\n${before.remotes}`)
write(join(baseline, 'worktrees.txt'), before.worktreeList)
write(join(baseline, 'dirty-worktrees.txt'), dirtyStates.map((state) => [
  `PATH=${state.path}`,
  `BRANCH=${state.branch ?? 'UNKNOWN'}`,
  `HEAD=${state.head ?? 'UNKNOWN'}`,
  `AHEAD=${state.ahead ?? 'UNKNOWN'}`,
  `BEHIND=${state.behind ?? 'UNKNOWN'}`,
  `STATUS_ERROR=${state.statusError ?? ''}`,
  state.status,
].join('\n')).join('\n\n') + '\n')
write(join(baseline, 'ahead-behind.txt'), worktreeStates.map((state) => `${state.branch ?? 'DETACHED'}\t${state.head ?? 'UNKNOWN'}\tahead=${state.ahead ?? 'UNKNOWN'}\tbehind=${state.behind ?? 'UNKNOWN'}\t${state.path}`).join('\n') + '\n')
write(join(baseline, 'stash.txt'), before.stash)
write(join(baseline, 'open-prs.json'), (() => {
  const result = runGh(['pr', 'list', '--repo', 'gthgomez/Babel', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup,url'])
  return result.ok ? result.stdout : JSON.stringify({ status: 'UNAVAILABLE', error: result.stderr }, null, 2)
})() + '\n')
write(join(baseline, 'recent-merges.json'), (() => {
  const result = runGh(['pr', 'list', '--repo', 'gthgomez/Babel', '--state', 'merged', '--limit', '40', '--json', 'number,title,mergeCommit,headRefName,baseRefName,mergedAt,url'])
  return result.ok ? result.stdout : JSON.stringify({ status: 'UNAVAILABLE', error: result.stderr }, null, 2)
})() + '\n')

const preservationRoot = join(output, 'preservation')
const preservationIndex = []
for (const state of dirtyStates) {
  const id = slug(state.path === repo ? 'main-' + before.branch : state.branch ?? state.path)
  const root = join(preservationRoot, id)
  const metadata = {
    schemaVersion: 1,
    capturedAt: before.capturedAt,
    worktreeId: id,
    path: state.path,
    branch: state.branch,
    head: state.head,
    registeredHead: state.registeredHead,
    mergeBaseWithOriginMain: run(['merge-base', 'HEAD', 'origin/main'], state.path).stdout.trim() || null,
    ahead: state.ahead,
    behind: state.behind,
    dirty: Boolean(state.status.trim()),
    statusReadable: !state.statusError,
    statusError: state.statusError,
    trackedChangeCount: lines(state.trackedChanges).length,
    stagedChangeCount: lines(state.stagedChanges).length,
    untrackedCount: lines(state.untrackedFiles).length,
    purpose: 'UNCLASSIFIED — reconcile from diff evidence before cleanup',
  }
  json(join(root, 'metadata.json'), metadata)
  write(join(root, 'git-status.txt'), state.statusError ? `${state.statusError}\n${state.status}` : state.status)
  write(join(root, 'diff-working-tree.patch'), state.diff)
  write(join(root, 'diff-staged.patch'), state.stagedDiff)
  write(join(root, 'untracked-files.txt'), state.untrackedFiles)
  write(join(root, 'commits-ahead.txt'), state.commitsAhead)
  write(join(root, 'changed-files.txt'), [state.trackedChanges, state.stagedChanges, state.untrackedFiles].filter(Boolean).join('\n'))
  const copied = []
  for (const file of lines(state.untrackedFiles)) {
    if (!isCopyableUntracked(file)) continue
    const source = join(state.path, file)
    if (!existsSync(source)) continue
    const target = join(root, 'untracked', file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    copied.push(file)
  }
  json(join(root, 'metadata.json'), { ...metadata, copiedUntrackedSourceFiles: copied })
  preservationIndex.push({ id, ...metadata, copiedUntrackedSourceFiles: copied })
}
json(join(output, 'preservation', 'index.json'), { schemaVersion: 1, capturedAt: before.capturedAt, worktrees: preservationIndex })
json(join(output, 'baseline', 'inventory.json'), { ...before, worktreeStates: worktreeStates.map(({ diff, stagedDiff, ...rest }) => rest), dirtyWorktreeCount: dirtyStates.length })
process.stdout.write(JSON.stringify({ output, originMain: before.originMain, currentHead: before.head, worktrees: before.worktrees.length, dirtyWorktrees: dirtyStates.length }, null, 2) + '\n')
