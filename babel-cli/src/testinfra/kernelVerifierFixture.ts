import type { ExecutorVerifierReceipt, RequiredVerifierRecord, VerifierEvidenceOwner } from '../executor/contracts.js'

/** Synthetic host facts for unit tests of the later criterion boundary. No process execution is claimed. */
export function kernelVerifierFixture() {
  const context = { workspaceRoot: '/fixture', taskId: 'task', contractHash: 'contract', workingDirectory: '/fixture', environmentFingerprint: 'environment', targetSelectors: [] }
  const verifierOwner: VerifierEvidenceOwner = { ...context, sessionId: 'session' }
  const requiredVerifiers: RequiredVerifierRecord[] = [{ command: 'npm test', executionContext: context, requiredScope: 'full_suite', greenRequired: true }]
  const receipt: ExecutorVerifierReceipt = {
    receiptId: 'fixture-receipt', command: 'npm test', argv: ['npm', 'test'], exitCode: 0, authority: true,
    authoritySource: 'built_in_runner', capturedAt: 1, stale: false, scope: 'full_suite', tests_total: 1, tests_skipped: 0,
    boundRevision: { gitCommitHash: null, compositeTreeHash: 'fixture-revision', fileHashes: {}, capturedAt: 1 },
    executionContext: context, order: { sessionId: 'session', seq: 1 },
  }
  return { verifierOwner, requiredVerifiers, requiredVerifierCommands: ['npm test'], lastVerifierReceipt: receipt,
    executedVerifierLedger: [receipt], currentWorkspaceRevisionHash: 'fixture-revision' }
}
