import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { SafeExecutor } from './sandbox.js'
import { executeTool } from './localTools.js'

test('file_read denies hard-linked outside content', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-read-hardlink-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    const outside = join(root, 'outside'); fs.writeFileSync(outside, 'SYNTHETIC_OUTSIDE_READ_CANARY')
    fs.linkSync(outside, join(project, 'linked.txt'))
    const result = new SafeExecutor(project).fileRead('linked.txt')
    assert.notEqual(result.exit_code, 0)
    assert.doesNotMatch(result.stdout, /SYNTHETIC_OUTSIDE_READ_CANARY/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('model-facing anchored directory listing returns ordinary project entries', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-list-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'visible.txt'), 'safe')
    const result = await executeTool({ tool: 'directory_list', path: '.' }, { projectRoot: project, agentId: 'executor', runId: 'fixture', runDir: root, babelRoot: root })
    assert.equal(result.exit_code, 0, result.stderr)
    assert.match(result.stdout, /file visible\.txt/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('model-facing file reads observe external edits within a run', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-read-freshness-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    const file = join(project, 'visible.txt'); fs.writeFileSync(file, 'initial')
    const context = { projectRoot: project, agentId: 'executor', runId: 'same-run', runDir: root, babelRoot: root }
    assert.match((await executeTool({ tool: 'file_read', path: 'visible.txt' }, context)).stdout, /initial/)
    fs.writeFileSync(file, 'external update')
    assert.match((await executeTool({ tool: 'file_read', path: 'visible.txt' }, context)).stdout, /external update/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('model-facing directory listings observe external edits across runs', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-freshness-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'initial.txt'), 'safe')
    const context = { projectRoot: project, agentId: 'executor', runId: 'first-run', runDir: root, babelRoot: root }
    assert.match((await executeTool({ tool: 'directory_list', path: '.' }, context)).stdout, /initial\.txt/)
    fs.writeFileSync(join(project, 'new.txt'), 'safe')
    assert.match((await executeTool({ tool: 'directory_list', path: '.' }, { ...context, runId: 'second-run' })).stdout, /new\.txt/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('model-facing text search observes external edits within a run', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-search-freshness-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    const file = join(project, 'visible.txt'); fs.writeFileSync(file, 'needle initial')
    const context = { projectRoot: project, agentId: 'executor', runId: 'same-run-search', runDir: root, babelRoot: root }
    assert.match((await executeTool({ tool: 'grep', pattern: 'needle', path: '.' }, context)).stdout, /initial/)
    fs.writeFileSync(file, 'needle updated')
    assert.match((await executeTool({ tool: 'grep', pattern: 'needle', path: '.' }, context)).stdout, /updated/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('model-facing directory output is bounded with a usable continuation', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-bounded-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    for (let index = 0; index < 550; index++) fs.writeFileSync(join(project, `${String(index).padStart(4, '0')}-${'x'.repeat(190)}.txt`), '')
    const context = { projectRoot: project, agentId: 'executor', runId: 'bounded-list', runDir: root, babelRoot: root }
    const result = await executeTool({ tool: 'directory_list', path: '.' }, context)
    assert.equal(result.exit_code, 0, result.stderr)
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 100 * 1024, 'directory observation exceeds the existing file-read byte budget')
    assert.match(result.stdout, /continuation/i)
    const continuation = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('Continuation: '))!.slice('Continuation: '.length)) as { after: string; revision: string }
    const incomplete = await executeTool({ tool: 'directory_list', path: '.', after: continuation.after }, context)
    assert.notEqual(incomplete.exit_code, 0); assert.match(incomplete.stderr, /both after and revision/i)
    const seen = new Set(result.stdout.split('\n').filter(line => line.startsWith('file ')))
    let cursor: { after: string; revision: string } | null = continuation
    while (cursor) {
      const next = await executeTool({ tool: 'directory_list', path: '.', ...cursor }, context)
      assert.equal(next.exit_code, 0, next.stderr)
      assert.ok(Buffer.byteLength(next.stdout, 'utf8') <= 100 * 1024)
      for (const line of next.stdout.split('\n').filter(value => value.startsWith('file '))) { assert.equal(seen.has(line), false, 'page repeated an entry'); seen.add(line) }
      const line = next.stdout.split('\n').find(value => value.startsWith('Continuation: '))
      cursor = line ? JSON.parse(line.slice('Continuation: '.length)) as { after: string; revision: string } : null
    }
    assert.equal(seen.size, 550)
    fs.writeFileSync(join(project, 'new-entry.txt'), '')
    const stale = await executeTool({ tool: 'directory_list', path: '.', ...continuation }, context)
    assert.notEqual(stale.exit_code, 0)
    assert.match(stale.stderr, /changed.*start/i)
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('directory page rejects changes during its enumeration', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-change-during-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'first.txt'), 'safe')
    const original = fs.Dir.prototype.readSync; let changed = false
    t.mock.method(fs.Dir.prototype, 'readSync', function (this: fs.Dir, ...args: unknown[]) {
      const entry = Reflect.apply(original, this, args)
      if (!changed && entry) { changed = true; fs.writeFileSync(join(project, 'new.txt'), 'safe') }
      return entry
    } as typeof original)
    const result = await executeTool({ tool: 'directory_list', path: '.' }, { projectRoot: project, agentId: 'executor', runId: 'changing-page', runDir: root, babelRoot: root })
    assert.equal(changed, true); assert.notEqual(result.exit_code, 0)
    assert.equal(result.stdout, ''); assert.match(result.stderr, /directory changed/i)
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded directory listing preserves in-root shadow read-through', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-shadow-'))
  try {
    const project = join(root, 'project'); const shadow = join(root, 'shadow')
    fs.mkdirSync(join(project, 'src'), { recursive: true }); fs.mkdirSync(join(shadow, 'src'), { recursive: true })
    fs.writeFileSync(join(shadow, 'src', 'shadow.txt'), 'safe')
    const result = await new SafeExecutor(project, shadow).listDirectoryGuarded('src')
    assert.equal(result.exit_code, 0, result.stderr)
    assert.match(result.stdout, /file shadow\.txt/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('cancelled guarded directory listing does not return a late result', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-list-abort-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'visible.txt'), 'safe')
    const controller = new AbortController(); const original = fs.opendirSync; let observed = false
    t.mock.method(fs, 'opendirSync', ((...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args)
      if (typeof args[0] === 'string' && (args[0] === project || /^\/(?:proc\/self|dev)\/fd\//.test(args[0]))) { observed = true; controller.abort() }
      return result
    }) as typeof fs.opendirSync)
    syncBuiltinESMExports()
    await assert.rejects(executeTool({ tool: 'directory_list', path: '.' }, { projectRoot: project, agentId: 'executor', runId: 'fixture', runDir: root, babelRoot: root, signal: controller.signal }), /abort/i)
    assert.equal(observed, true)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('cancellation during directory anchor acquisition releases ownership before returning', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-acquire-abort-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'visible.txt'), 'safe')
    const controller = new AbortController()
    const result = new SafeExecutor(project).listDirectoryGuarded('.', controller.signal)
    controller.abort()
    await assert.rejects(result, /abort/i)
    fs.renameSync(project, join(root, 'released'))
    assert.equal(fs.existsSync(join(root, 'released', 'visible.txt')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('file_read does not expose outside bytes when a parent is replaced after stat', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-read-race-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    const file = join(source, 'input.txt')
    fs.writeFileSync(file, 'safe'); fs.writeFileSync(join(outside, 'input.txt'), 'SYNTHETIC_OUTSIDE_READ_CANARY')
    const executor = new SafeExecutor(project); const original = fs.statSync; let swapped = false
    t.mock.method(fs, 'statSync', ((...args: unknown[]) => {
      const info = Reflect.apply(original, fs, args)
      if (!swapped && args[0] === file) {
        swapped = true; fs.renameSync(source, join(project, 'src-before'))
        fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return info
    }) as typeof fs.statSync)
    syncBuiltinESMExports()
    const result = executor.fileRead('src/input.txt')
    assert.equal(swapped, true)
    assert.doesNotMatch(result.stdout, /SYNTHETIC_OUTSIDE_READ_CANARY/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('file_read directory listing does not expose names after a junction swap', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-dir-race-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(source, 'safe.txt'), 'safe'); fs.writeFileSync(join(outside, 'SYNTHETIC_PRIVATE_NAME'), 'private')
    const executor = new SafeExecutor(project); const original = fs.statSync; let swapped = false
    t.mock.method(fs, 'statSync', ((...args: unknown[]) => {
      const info = Reflect.apply(original, fs, args)
      if (!swapped && args[0] === source) {
        swapped = true; fs.renameSync(source, join(project, 'src-before'))
        fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return info
    }) as typeof fs.statSync)
    syncBuiltinESMExports()
    const result = executor.fileRead('src')
    assert.equal(swapped, true)
    assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_NAME/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('directory_list does not expose names after a junction swap', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-race-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'SYNTHETIC_PRIVATE_NAME'), 'private')
    const executor = new SafeExecutor(project); const original = fs.statSync; let swapped = false
    t.mock.method(fs, 'statSync', ((...args: unknown[]) => {
      const info = Reflect.apply(original, fs, args)
      if (!swapped && args[0] === source) {
        swapped = true; fs.renameSync(source, join(project, 'src-before'))
        fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return info
    }) as typeof fs.statSync)
    syncBuiltinESMExports()
    const result = executor.listDirectory('src')
    assert.equal(swapped, true)
    assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_NAME/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('directory_list does not disclose names when a junction is swapped and restored during enumeration', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-swap-restore-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'SYNTHETIC_PRIVATE_NAME'), 'private')
    const executor = new SafeExecutor(project); const original = fs.readdirSync; let swapped = false
    t.mock.method(fs, 'readdirSync', ((...args: unknown[]) => {
      if (!swapped && args[0] === source) {
        swapped = true; const backup = join(project, 'src-before')
        fs.renameSync(source, backup); fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
        try { return Reflect.apply(original, fs, args) }
        finally { fs.unlinkSync(source); fs.renameSync(backup, source) }
      }
      return Reflect.apply(original, fs, args)
    }) as typeof fs.readdirSync)
    syncBuiltinESMExports()
    const result = executor.listDirectory('src')
    assert.equal(result.exit_code, 1, 'unguarded synchronous enumeration must be contained')
    assert.equal(swapped, false, 'containment must occur before enumeration')
    assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_NAME/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('model-facing directory_list does not return names from a swap-and-restore junction', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-tool-list-swap-restore-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'SYNTHETIC_PRIVATE_NAME'), 'private')
    const original = fs.opendirSync; let swapped = false
    t.mock.method(fs, 'opendirSync', ((...args: unknown[]) => {
      if (!swapped && typeof args[0] === 'string' && (args[0] === source || /^\/(?:proc\/self|dev)\/fd\//.test(args[0]))) {
        swapped = true; const backup = join(project, 'src-before')
        fs.renameSync(source, backup); fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
        try { return Reflect.apply(original, fs, args) }
        finally { fs.unlinkSync(source); fs.renameSync(backup, source) }
      }
      return Reflect.apply(original, fs, args)
    }) as typeof fs.opendirSync)
    syncBuiltinESMExports()
    const result = await executeTool({ tool: 'directory_list', path: 'src' }, { projectRoot: project, agentId: 'executor', runId: 'fixture', runDir: root, babelRoot: root })
    assert.equal(swapped, true, JSON.stringify(result))
    assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_NAME/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded directory enumeration yields so cancellation can stop an active scan', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-cancel-scan-'))
  const opendir = fs.opendirSync
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    for (let index = 0; index < 700; index++) fs.writeFileSync(join(project, `file-${String(index).padStart(4, '0')}.txt`), '')
    const controller = new AbortController()
    let started = false
    let reads = 0
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const dir = opendir(...args)
      const read = dir.readSync.bind(dir)
      dir.readSync = () => {
        reads++
        if (!started) { started = true; setImmediate(() => controller.abort(new Error('SYNTHETIC_SCAN_CANCELLED'))) }
        return read()
      }
      return dir
    }) as typeof fs.opendirSync
    syncBuiltinESMExports()
    await assert.rejects(new SafeExecutor(project).listDirectoryGuarded('.', controller.signal), /SYNTHETIC_SCAN_CANCELLED/)
    assert.equal(started, true)
    assert.ok(reads <= 128, `scan continued for ${reads} entries after cancellation became runnable`)
    fs.renameSync(project, join(root, 'renamed-project'))
  } finally { fs.opendirSync = opendir; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded listing rejects if its owned Windows directory guard exits during enumeration', async t => {
  if (process.platform !== 'win32') { t.skip('Windows directory helper'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-guard-exit-'))
  const opendir = fs.opendirSync; const spawn = childProcess.spawn
  let helper: ReturnType<typeof childProcess.spawn> | undefined
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'visible.txt'), 'safe')
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = spawn(...args); helper = child; return child
    }) as typeof childProcess.spawn
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const dir = opendir(...args); const read = dir.readSync.bind(dir); let first: fs.Dirent | null = null; let count = 0
      dir.readSync = () => {
        if (count++ === 0) { first = read(); assert.ok(helper, 'guard must be owned before enumeration'); helper.kill() }
        return count <= 20000 ? first : null
      }
      return dir
    }) as typeof fs.opendirSync
    syncBuiltinESMExports()
    const result = await new SafeExecutor(project).listDirectoryGuarded('.')
    assert.notEqual(result.exit_code, 0)
    assert.equal(result.stdout, '')
  } finally { childProcess.spawn = spawn; fs.opendirSync = opendir; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded listing rejects when its owned guard is killed outside its ChildProcess handle', async t => {
  if (process.platform !== 'win32') { t.skip('Windows directory helper'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-list-guard-external-exit-'))
  const opendir = fs.opendirSync; const spawn = childProcess.spawn
  let helper: ReturnType<typeof childProcess.spawn> | undefined
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'visible.txt'), 'safe')
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = spawn(...args); helper = child; return child
    }) as typeof childProcess.spawn
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const dir = opendir(...args); const read = dir.readSync.bind(dir); let first: fs.Dirent | null = null; let count = 0
      dir.readSync = () => {
        if (count++ === 0) { first = read(); assert.ok(helper?.pid, 'guard must be owned before enumeration'); process.kill(helper.pid) }
        return count <= 20000 ? first : null
      }
      return dir
    }) as typeof fs.opendirSync
    syncBuiltinESMExports()
    const result = await new SafeExecutor(project).listDirectoryGuarded('.')
    assert.notEqual(result.exit_code, 0)
    assert.equal(result.stdout, '')
  } finally { childProcess.spawn = spawn; fs.opendirSync = opendir; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})
