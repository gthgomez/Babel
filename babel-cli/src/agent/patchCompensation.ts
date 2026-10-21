import { open, lstat, rename, link, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ToolContext } from '../localTools.js'
import { WorkspaceTransactionManager } from '../services/workspaceTransactions.js'
import { recordEffectIntent, recordEffectTerminal, type EffectLedgerRecord } from '../executor/effectLedger.js'
import { captureEffectParentIdentity, resolveOwnedEffectPath, type EffectParentIdentity } from '../executor/effectPathIdentity.js'
import { acquireEffectDirectoryAnchors, type EffectDirectoryAnchors } from '../executor/effectDirectoryAnchors.js'

export interface PatchRollbackOutcome { rolledBack: string[]; failures: string[] }
const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Caller retains its FileWriteMutex locks. Capture by rename, validate the
 * captured entry, and recreate exclusively: never overwrite or unlink a name
 * after an ownership check. Captures are retained, including on success, so an
 * external writer holding the old inode cannot lose bytes to our cleanup.
 * Intent names the capture before rename; unsettled intents require recovery.
 */
export async function compensatePatchWrites(
  paths: string[], originals: Map<string, string>, created: Set<string>,
  written: Map<string, string>, effects: Map<string, EffectLedgerRecord>, context: ToolContext,
  ephemeralParents?: Map<string, EffectParentIdentity>,
): Promise<PatchRollbackOutcome> {
  const rolledBack: string[] = []
  const failures: string[] = []
  for (const path of [...paths].reverse()) {
    let intent: EffectLedgerRecord | undefined
    let restored = false
    let capture: string | undefined
    let captured = false
    let intentAttempted = false
    let captureParent: EffectParentIdentity | undefined
    let anchors: EffectDirectoryAnchors | undefined
    const original = effects.get(path)
    const parent = original?.targetParentIdentities?.[path] ?? ephemeralParents?.get(path)
    const ownedTarget = (): string => {
      if (!parent) throw new Error('EFFECT_PARENT_IDENTITY_UNAVAILABLE')
      return resolveOwnedEffectPath(path, parent)
    }
    const expected = written.get(path)
    const restoration = created.has(path) ? WorkspaceTransactionManager.missingPathDigest() : hash(originals.get(path) ?? '')
    try {
      if (context.runDir && (!original || original.preImageHashes[path] !== restoration)) {
        throw new Error('original durable effect identity unavailable or inconsistent')
      }
      // Rename must stay on one volume; retain cross-volume captures beside
      // the target and name them in durable evidence rather than copying bytes.
      const targetInfo = await lstat(dirname(ownedTarget()))
      const evidenceRoot = context.runDir ?? dirname(path)
      await mkdir(evidenceRoot, { recursive: true })
      const evidenceCanonical = await realpath(evidenceRoot)
      const evidenceInfo = await lstat(evidenceCanonical)
      const captureRoot = evidenceInfo.dev === targetInfo.dev ? evidenceCanonical : dirname(ownedTarget())
      const rootIdentity = captureEffectParentIdentity(join(captureRoot, 'entry'))
      resolveOwnedEffectPath(join(captureRoot, 'entry'), rootIdentity)
      capture = join(await mkdtemp(join(captureRoot, '.babel-compensation-')), 'captured')
      resolveOwnedEffectPath(join(captureRoot, 'entry'), rootIdentity)
      captureParent = captureEffectParentIdentity(capture)
      if (context.runDir && original) {
        intentAttempted = true
        intent = recordEffectIntent({
        runDir: context.runDir, sessionId: original.sessionId, turnId: original.turnId,
        mutationBatchId: original.mutationBatchId, effectClass: 'reconcilable_mutation',
        toolName: 'apply_patch_compensation', targetPaths: [path],
        preImageHashes: { [path]: expected === undefined ? 'unknown' : hash(expected) },
        compensatesOperationId: original.operationId, restorationHashes: { [path]: restoration },
        compensationCapturePath: capture,
        ...(original.targetParentIdentities ? { targetParentIdentities: original.targetParentIdentities } : {}),
      }) }
      anchors = await acquireEffectDirectoryAnchors([dirname(ownedTarget()), dirname(resolveOwnedEffectPath(capture, captureParent))])
      // Revalidate after acquisition: a replacement before handles were opened
      // must fail before either capture or restoration touches an entry.
      ownedTarget(); resolveOwnedEffectPath(capture, captureParent)
      let before
      try { before = await lstat(anchors.path(ownedTarget())) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !created.has(path)) throw error
      }
      if (!before && created.has(path)) {
        restored = true
      } else {
        if (!before?.isFile() || before.isSymbolicLink() || (before.mode & 0o222) === 0) {
          throw new Error('not restored — target is not a writable owned regular file')
        }
        await rename(anchors.path(ownedTarget()), anchors.path(resolveOwnedEffectPath(capture, captureParent)))
        captured = true
        const capturedInfo = await lstat(anchors.path(resolveOwnedEffectPath(capture, captureParent)))
        if (!capturedInfo.isFile() || capturedInfo.isSymbolicLink()) throw new Error('captured entry changed type')
        const source = await open(anchors.path(resolveOwnedEffectPath(capture, captureParent)), 'r')
        try {
          const info = await source.stat()
          if (info.ino !== capturedInfo.ino || info.dev !== capturedInfo.dev || expected === undefined
            || await source.readFile('utf8') !== expected) throw new Error('not restored — the file no longer holds the bytes this patch wrote')
        } finally { await source.close() }
        if (created.has(path)) {
          try { await lstat(anchors.path(ownedTarget())); throw new Error('created path replaced during compensation') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        } else {
          const destination = await open(anchors.path(ownedTarget()), 'wx+', before.mode & 0o777)
          try {
            const bytes = Buffer.from(originals.get(path) ?? '', 'utf8')
            await destination.write(bytes, 0, bytes.length, 0)
            await destination.truncate(bytes.length)
            await destination.chmod(before.mode & 0o777)
            await destination.sync()
            const info = await destination.stat()
            const named = await lstat(anchors.path(ownedTarget()))
            if (named.isSymbolicLink() || named.ino !== info.ino || named.dev !== info.dev
              || hash(await destination.readFile('utf8')) !== restoration) throw new Error('restoration post-image not confirmed')
          } finally { await destination.close() }
        }
        restored = true
      }
      if (intent && context.runDir) recordEffectTerminal(context.runDir, intent, {
        status: 'completed', postImageHashes: { [path]: restoration },
      })
      rolledBack.push(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!intent && !intentAttempted && original && context.runDir) {
        try {
          intent = recordEffectIntent({ runDir: context.runDir, sessionId: original.sessionId,
            turnId: original.turnId, mutationBatchId: original.mutationBatchId, effectClass: 'reconcilable_mutation',
            toolName: 'apply_patch_compensation', targetPaths: [path], preImageHashes: { [path]: expected === undefined ? 'unknown' : hash(expected) },
            compensatesOperationId: original.operationId, restorationHashes: { [path]: restoration } })
        } catch { /* persistence unavailable; no filesystem effect is attempted */ }
      }
      // Restore a conflicting capture only through exclusive creation. An
      // external replacement at the destination always wins.
      if (captured && capture && captureParent && anchors && !restored) {
        try { await link(anchors.path(resolveOwnedEffectPath(capture, captureParent)), anchors.path(ownedTarget())) } catch { /* retained capture is the recovery path */ }
      }
      if (intent && context.runDir && !restored) {
        try { recordEffectTerminal(context.runDir, intent, { status: 'failed', error: message }) }
        catch { /* interrupted intent remains authoritative */ }
      }
      failures.push(`${path}: ${restored ? 'restored bytes; durable settlement uncertain' : 'restore failed'} — ${message}`
        + (captured ? `; captured entry retained at ${capture}` : ''))
    } finally {
      try { await anchors?.release() } catch { failures.push(`${path}: directory anchor cleanup incomplete`) }
    }
  }
  return { rolledBack, failures }
}
