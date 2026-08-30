#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const valueFor = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const repo = resolve(valueFor('--repo', process.cwd()))
const output = resolve(valueFor('--output', join(repo, 'artifacts', 'final-consolidation')))
const sourceLike = /\.(?:patch|diff|jsonl?|md|ts|tsx|js|mjs|cjs|ps1|json|ya?ml|toml|lock|css|html|txt)$/i
const blockedName = /^(?:\.env(?:\..*)?|auth\.json|credentials?\.json|.*(?:secret|token|api[-_]?key).*)$/i
const ignoredDirectory = /^(?:node_modules|dist|runs|artifacts|\.git|coverage|\.cache|\.next|target)$/i

function git(args, cwd = repo) {
  try {
    return { ok: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error) }
  }
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function json(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function safeRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/')
}

function uniqueId(state) {
  return createHash('sha256')
    .update(`${resolve(state.path).replaceAll('\\', '/').toLowerCase()}\0${state.head ?? 'UNKNOWN'}\0${state.branch ?? 'DETACHED'}`)
    .digest('hex')
    .slice(0, 24)
}

function parseWorktrees() {
  const result = git(['worktree', 'list', '--porcelain'])
  const entries = []
  let current = null
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice(9) }
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5)
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (current && line === 'detached') current.branch = 'DETACHED'
  }
  if (current) entries.push(current)
  return entries
}

function fileInventory(root, copyRoot, includeAllSourceLike = false, selectedFiles = null) {
  const files = []
  const walk = (directory) => {
    let names
    try { names = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of names) {
      const source = join(directory, entry.name)
      const rel = safeRelative(root, source)
      if (entry.isDirectory()) {
        if (ignoredDirectory.test(entry.name) || entry.name.startsWith('.')) continue
        walk(source)
        continue
      }
      if (!entry.isFile() || blockedName.test(entry.name)) continue
      if (!includeAllSourceLike && !sourceLike.test(entry.name)) continue
      if (!includeAllSourceLike && selectedFiles && !selectedFiles.has(rel)) continue
      let stat
      try { stat = statSync(source) } catch { continue }
      const record = { path: rel, size: stat.size, mtime: stat.mtime.toISOString(), sha256: sha256(source) }
      files.push(record)
      if (copyRoot) {
        const target = join(copyRoot, rel)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(source, target)
      }
    }
  }
  if (existsSync(root)) walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

const capturedAt = new Date().toISOString()
const entries = parseWorktrees()
const states = []
for (const entry of entries) {
  const id = uniqueId(entry)
  const status = git(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], entry.path)
  const staged = git(['diff', '--cached', '--name-only'], entry.path)
  const unstaged = git(['diff', '--name-only'], entry.path)
  const untracked = git(['ls-files', '--others', '--exclude-standard'], entry.path)
  const head = git(['rev-parse', 'HEAD'], entry.path)
  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], entry.path)
  const actualHead = head.ok ? head.stdout.trim() : entry.head ?? null
  const actualBranch = branch.ok && branch.stdout.trim() ? branch.stdout.trim() : entry.branch ?? 'DETACHED'
  const readable = status.ok && head.ok
  const root = join(output, 'preservation', 'worktrees', id)
  const copiedRoot = join(root, 'files')
  const changedFiles = new Set([
    ...staged.stdout.split(/\r?\n/).filter(Boolean),
    ...unstaged.stdout.split(/\r?\n/).filter(Boolean),
    ...untracked.stdout.split(/\r?\n/).filter(Boolean),
  ])
  const isDirtyOrUnreadable = !readable || changedFiles.size > 0
  const sourceFiles = fileInventory(entry.path, isDirtyOrUnreadable ? copiedRoot : null, !readable, readable ? changedFiles : null)
  const workingPatch = git(['diff', '--binary'], entry.path)
  const stagedPatch = git(['diff', '--cached', '--binary'], entry.path)
  const metadata = {
    schema_version: 2,
    preservation_id: id,
    captured_at: capturedAt,
    absolute_path: resolve(entry.path),
    branch: actualBranch,
    head_sha: actualHead,
    registered_head_sha: entry.head ?? null,
    status_readable: readable,
    status_error: status.ok ? null : status.stderr.trim(),
    reachability_from_origin_main: git(['merge-base', '--is-ancestor', actualHead ?? 'HEAD', 'origin/main'], entry.path).ok ? 'ANCESTOR_OR_EQUAL' : 'NOT_ESTABLISHED',
    staged_files: staged.stdout.split(/\r?\n/).filter(Boolean),
    unstaged_files: unstaged.stdout.split(/\r?\n/).filter(Boolean),
    untracked_files: untracked.stdout.split(/\r?\n/).filter(Boolean),
    source_like_files_preserved: sourceFiles,
    classification: readable ? 'UNKNOWN' : sourceFiles.length ? 'UNREADABLE_AND_PRESERVED' : 'UNREADABLE_AND_UNRESOLVED',
    safe_to_remove: false,
  }
  json(join(root, 'metadata.json'), metadata)
  write(join(root, 'status.txt'), status.stdout || status.stderr)
  write(join(root, 'tracked.patch'), workingPatch.stdout)
  write(join(root, 'staged.patch'), stagedPatch.stdout)
  json(join(root, 'untracked-manifest.json'), { files: sourceFiles, omitted_non_source_or_sensitive: true })
  states.push(metadata)
}

const baseline = join(output, 'baseline')
mkdirSync(baseline, { recursive: true })
write(join(baseline, 'repository-state.txt'), [
  `captured_at=${capturedAt}`,
  `repo=${repo}`,
  `origin=${git(['remote', 'get-url', 'origin']).stdout.trim()}`,
  `origin_main=${git(['rev-parse', 'origin/main']).stdout.trim()}`,
  `head=${git(['rev-parse', 'HEAD']).stdout.trim()}`,
  `branch=${git(['branch', '--show-current']).stdout.trim()}`,
  '',
  git(['status', '--short', '--branch', '--untracked-files=all']).stdout,
].join('\n'))
write(join(baseline, 'branches.txt'), git(['branch', '-vv']).stdout)
write(join(baseline, 'remote-branches.txt'), git(['branch', '-r', '-vv']).stdout)
write(join(baseline, 'worktrees.txt'), git(['worktree', 'list', '--porcelain']).stdout)
write(join(baseline, 'stash.txt'), git(['stash', 'list', '--date=local']).stdout)
json(join(output, 'preservation', 'PRESERVATION_LEDGER.json'), {
  schema_version: 2,
  captured_at: capturedAt,
  total_worktrees: states.length,
  dirty_or_unreadable: states.filter((state) => state.status_error || state.staged_files.length || state.unstaged_files.length || state.untracked_files.length).length,
  unreadable: states.filter((state) => !state.status_readable).length,
  fully_preserved: states.filter((state) => state.status_readable && state.source_like_files_preserved.every((file) => file.sha256)).length,
  unresolved: states.filter((state) => state.classification === 'UNREADABLE_AND_UNRESOLVED').length,
  worktrees: states,
})
write(join(output, 'preservation', 'PRESERVATION_LEDGER.md'), [
  '# Final preservation ledger',
  '',
  `Captured: ${capturedAt}`,
  `Worktrees: ${states.length}`,
  `Unreadable: ${states.filter((state) => !state.status_readable).length}`,
  '',
  '| Preservation ID | Branch | HEAD | Readable | Files preserved | Classification |',
  '|---|---|---|---:|---:|---|',
  ...states.map((state) => `| ${state.preservation_id} | ${state.branch} | ${state.head_sha ?? 'UNKNOWN'} | ${state.status_readable} | ${state.source_like_files_preserved.length} | ${state.classification} |`),
  '',
  'No state is marked safe to remove by this automated pass. Any cleanup requires a later evidence-backed disposition.',
].join('\n') + '\n')
json(join(output, 'preservation', 'index.json'), { schema_version: 2, captured_at: capturedAt, worktrees: states.map((state) => ({ id: state.preservation_id, path: state.absolute_path, branch: state.branch, head: state.head_sha, readable: state.status_readable })) })
process.stdout.write(JSON.stringify({ output, worktrees: states.length, unreadable: states.filter((state) => !state.status_readable).length, preservationIds: states.map((state) => state.preservation_id) }, null, 2) + '\n')
