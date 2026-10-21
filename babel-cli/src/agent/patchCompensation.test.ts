import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { compensatePatchWrites } from './patchCompensation.js'
import { interpretCompensations, loadEffectLedger, recordEffectIntent, recordEffectTerminal } from '../executor/effectLedger.js'
import { WorkspaceTransactionManager } from '../services/workspaceTransactions.js'
import { captureEffectParentIdentity } from '../executor/effectPathIdentity.js'

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

for (const replaceParent of [false, true]) {
  test(`compensation refuses unbound newly created parent directories (replacement=${replaceParent})`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-new-parent-'))
    try {
      const parent = join(root, 'new', 'nested')
      const path = join(parent, 'file.txt')
      const original = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch',
        effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
        targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
        preImageHashes: { [path]: WorkspaceTransactionManager.missingPathDigest() }, intendedContent: 'after' })
      fs.mkdirSync(parent, { recursive: true }); fs.writeFileSync(path, 'after')
      recordEffectTerminal(root, original, { status: 'completed', postImageHashes: { [path]: hash('after') } })
      const moved = join(root, 'new', 'moved')
      if (replaceParent) {
        fs.renameSync(parent, moved); fs.mkdirSync(parent); fs.writeFileSync(path, 'after')
      }
      const result = await compensatePatchWrites([path], new Map(), new Set([path]),
        new Map([[path, 'after']]), new Map([[path, original]]),
        { runDir: root, runId: 'session', agentId: 'test', babelRoot: root })
      assert.equal(fs.readFileSync(path, 'utf8'), 'after', 'an unbound parent must not authorize moving its file')
      if (replaceParent) assert.equal(fs.readFileSync(join(moved, 'file.txt'), 'utf8'), 'after')
      assert.equal(result.rolledBack.length, 0)
      assert.match(result.failures.join(), /PARENT_IDENTITY/)
      const compensation = loadEffectLedger(root).filter(record => record.compensatesOperationId === original.operationId).at(-1)
      assert.equal(compensation?.status, 'failed')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test('exclusive restoration preserves POSIX mode despite a restrictive umask', {
  skip: process.platform === 'win32' ? 'POSIX mode/umask semantics are not available on Windows' : false,
}, async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-mode-'))
  const path = join(root, 'owned.txt')
  const priorMask = process.umask(0o022)
  try {
    fs.writeFileSync(path, 'after'); fs.chmodSync(path, 0o666)
    const original = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch',
      effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
      targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
      preImageHashes: { [path]: hash('before') }, intendedContent: 'after' })
    recordEffectTerminal(root, original, { status: 'completed', postImageHashes: { [path]: hash('after') } })
    const result = await compensatePatchWrites([path], new Map([[path, 'before']]), new Set(),
      new Map([[path, 'after']]), new Map([[path, original]]),
      { runDir: root, runId: 'session', agentId: 'test', babelRoot: root })
    assert.equal(result.rolledBack.length, 1)
    assert.equal(fs.statSync(path).mode & 0o777, 0o666)
  } finally { process.umask(priorMask); fs.rmSync(root, { recursive: true, force: true }) }
})

test('compensation rejects a target parent replaced by a junction to an outside tree', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-parent-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    const sub = join(project, 'sub'); fs.mkdirSync(sub)
    const outside = join(root, 'outside'); fs.mkdirSync(outside)
    const path = join(sub, 'file.txt'); fs.writeFileSync(path, 'after')
    fs.writeFileSync(join(outside, 'file.txt'), 'after')
    const original = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch',
      effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
      targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
      preImageHashes: { [path]: hash('before') }, intendedContent: 'after' })
    recordEffectTerminal(root, original, { status: 'completed', postImageHashes: { [path]: hash('after') } })
    fs.renameSync(sub, join(project, 'original-sub'))
    fs.symlinkSync(outside, sub, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await compensatePatchWrites([path], new Map([[path, 'before']]), new Set(),
      new Map([[path, 'after']]), new Map([[path, original]]),
      { runDir: root, runId: 'session', agentId: 'test', babelRoot: project })
    assert.equal(fs.readFileSync(join(outside, 'file.txt'), 'utf8'), 'after')
    assert.equal(result.rolledBack.length, 0)
    assert.match(result.failures.join(), /PARENT_IDENTITY/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('parent replacement after pathname validation cannot redirect restoration into an outside tree', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-parent-race-'))
  const open = fsPromises.open
  try {
    const sub = join(root, 'sub'); fs.mkdirSync(sub)
    const outside = join(root, 'outside'); fs.mkdirSync(outside)
    const path = join(sub, 'file.txt'); fs.writeFileSync(path, 'after')
    const original = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch',
      effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
      targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
      preImageHashes: { [path]: hash('before') }, intendedContent: 'after' })
    recordEffectTerminal(root, original, { status: 'completed', postImageHashes: { [path]: hash('after') } })
    let attempted = false
    fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
      if (args[1] === 'wx+' && !attempted) {
        attempted = true
        try {
          fs.renameSync(sub, join(root, 'original-sub'))
          fs.symlinkSync(outside, sub, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
      return open(...args)
    }) as typeof fsPromises.open
    syncBuiltinESMExports()
    const result = await compensatePatchWrites([path], new Map([[path, 'before']]), new Set(),
      new Map([[path, 'after']]), new Map([[path, original]]),
      { runDir: root, runId: 'session', agentId: 'test', babelRoot: root })
    assert.equal(attempted, true, `the external replacement must be attempted after validation at open admission: ${result.failures.join('; ')}`)
    assert.equal(fs.existsSync(join(outside, 'file.txt')), false, 'compensation must never create bytes in the outside tree')
  } finally {
    fsPromises.open = open; syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('process interruption after restoration preserves uncertain cold history and a retained capture', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-crash-'))
  const path = join(root, 'owned.txt')
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { recordEffectIntent, recordEffectTerminal } from ${JSON.stringify(new URL('../executor/effectLedger.ts', import.meta.url).href)};
    import { compensatePatchWrites } from ${JSON.stringify(new URL('./patchCompensation.ts', import.meta.url).href)};
    import { captureEffectParentIdentity } from ${JSON.stringify(new URL('../executor/effectPathIdentity.ts', import.meta.url).href)};
    const root = ${JSON.stringify(root)}, path = ${JSON.stringify(path)};
    fs.writeFileSync(path, 'after');
    const original = recordEffectIntent({runDir:root,sessionId:'session',mutationBatchId:'batch',effectClass:'reconcilable_mutation',toolName:'write_file',targetPaths:[path],targetParentIdentities:{[path]:captureEffectParentIdentity(path)},preImageHashes:{[path]:${JSON.stringify(hash('before'))}},intendedContent:'after'});
    recordEffectTerminal(root, original, {status:'completed',postImageHashes:{[path]:${JSON.stringify(hash('after'))}}});
    const append = fs.appendFileSync; let appends = 0;
    fs.appendFileSync = (...args) => { if (++appends === 2) process.exit(86); return append(...args); };
    syncBuiltinESMExports();
    await compensatePatchWrites([path],new Map([[path,'before']]),new Set(),new Map([[path,'after']]),new Map([[path,original]]),{runDir:root,runId:'session',agentId:'test',babelRoot:root});
  `
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 30000,
    })
    assert.equal(child.status, 86, 'child must interrupt at the terminal append boundary')
    assert.equal(fs.readFileSync(path, 'utf8'), 'before')
    const cold = interpretCompensations(loadEffectLedger(root))
    assert.equal(cold[0]?.state, 'uncertain')
    const capture = cold[0]?.compensation.compensationCapturePath
    assert.ok(capture)
    assert.equal(fs.readFileSync(capture, 'utf8'), 'after')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

for (const created of [false, true]) {
  test(`compensation preserves external bytes at the ownership check/use boundary (created=${created})`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-race-'))
    const path = join(root, 'owned.txt')
    const lstat = fsPromises.lstat
    try {
      fs.writeFileSync(path, 'after')
      const original = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch',
        effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
        targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
        preImageHashes: { [path]: created ? WorkspaceTransactionManager.missingPathDigest() : hash('before') }, intendedContent: 'after' })
      recordEffectTerminal(root, original, { status: 'completed', postImageHashes: { [path]: hash('after') } })
      let checks = 0
      let replaced = false
      fsPromises.lstat = (async (...args: Parameters<typeof fsPromises.lstat>) => {
        const stat = await lstat(...args)
        if (stat.isFile() && ++checks === 2) { fs.writeFileSync(path, 'external-newer'); replaced = true }
        return stat
      }) as typeof fsPromises.lstat
      syncBuiltinESMExports()
      const result = await compensatePatchWrites([path], new Map([[path, 'before']]), created ? new Set([path]) : new Set(),
        new Map([[path, 'after']]), new Map([[path, original]]),
        { runDir: root, runId: 'session', agentId: 'test', babelRoot: root })
      assert.equal(replaced, true, 'external write must actually land at the barrier')
      assert.equal(fs.existsSync(path), true, 'external replacement must not be deleted')
      assert.equal(fs.readFileSync(path, 'utf8'), 'external-newer')
      assert.equal(result.rolledBack.length, 0)
      assert.equal(interpretCompensations(loadEffectLedger(root))[0]?.state, 'failed')
    } finally {
      fsPromises.lstat = lstat
      syncBuiltinESMExports()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const failureAt of ['intent', 'settlement', 'none'] as const) {
  test(`compensation persistence failure at ${failureAt} preserves honest cold history`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'babel-compensation-'))
    const path = join(root, 'owned.txt')
    const append = fs.appendFileSync
    try {
      fs.writeFileSync(path, 'after')
      const original = recordEffectIntent({ runDir: root, sessionId: 'session', mutationBatchId: 'batch',
        effectClass: 'reconcilable_mutation', toolName: 'write_file', targetPaths: [path],
        targetParentIdentities: { [path]: captureEffectParentIdentity(path) },
        preImageHashes: { [path]: hash('before') }, intendedContent: 'after' })
      recordEffectTerminal(root, original, { status: 'completed', postImageHashes: { [path]: hash('after') } })
      let appends = 0
      fs.appendFileSync = ((...args: Parameters<typeof fs.appendFileSync>) => {
        appends += 1
        if ((failureAt === 'intent' && appends === 1) || (failureAt === 'settlement' && appends === 2)) {
          throw new Error('injected ledger append failure')
        }
        return append(...args)
      }) as typeof fs.appendFileSync
      syncBuiltinESMExports()
      const result = await compensatePatchWrites([path], new Map([[path, 'before']]), new Set(),
        new Map([[path, 'after']]), new Map([[path, original]]),
        { runDir: root, runId: 'session', agentId: 'test', babelRoot: root })
      assert.equal(fs.readFileSync(path, 'utf8'), failureAt === 'intent' ? 'after' : 'before')
      assert.equal(result.rolledBack.length, failureAt === 'none' ? 1 : 0)
      const cold = interpretCompensations(loadEffectLedger(root))
      if (failureAt === 'intent') assert.deepEqual(cold, [])
      else assert.equal(cold[0]?.state, failureAt === 'settlement' ? 'uncertain' : 'completed')
      if (failureAt === 'settlement') assert.match(result.failures.join(), /durable settlement uncertain/)
    } finally {
      fs.appendFileSync = append
      syncBuiltinESMExports()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
