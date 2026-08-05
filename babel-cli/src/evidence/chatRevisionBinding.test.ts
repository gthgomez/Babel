import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bindChatVerifierReceipt,
  buildChatEvidenceGraph,
  CHAT_EVIDENCE_CLAIM_ID,
  evaluateChatCompletionProof,
  evaluateChatEvidenceGraph,
  mutationPathsFromSessionEvents,
  refreshChatVerifierReceiptStalenessSync,
  revisionBindingProofErrors,
  toRevisionBoundReceipt,
} from './chatRevisionBinding.js';
import { evaluateExecuteCompletionHonesty } from '../agent/completionGatePolicy.js';
import { createExecutorKernel } from '../executor/kernel.js';

describe('chatRevisionBinding', () => {
  it('collects unique mutation_batch paths', () => {
    const paths = mutationPathsFromSessionEvents([
      { kind: 'turn_started' },
      { kind: 'mutation_batch', paths: ['src/a.ts', 'src/b.ts'] },
      { kind: 'mutation_batch', paths: ['src/b.ts', 'src/c.ts'] },
      { kind: 'verifier_attempt' },
    ]);
    assert.deepStrictEqual(paths, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('binds receipt at capture and marks stale after file edit (sync recheck)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-chat-bind-'));
    try {
      const rel = 'src/mod.ts';
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tempDir, rel), 'v1');

      const receipt = await bindChatVerifierReceipt({
        projectRoot: tempDir,
        command: 'npm test',
        exit_code: 0,
        summary: 'ok',
        mutationPaths: [rel],
        structured: {
          verifierId: 'npm-test',
          authoritySource: 'built_in_runner',
          executable: 'npm',
          args: ['test'],
        },
      });

      assert.strictEqual(receipt.stale, false);
      assert.ok(receipt.boundRevision);
      assert.ok(receipt.boundRevision!.fileHashes[rel]);
      assert.ok(receipt.verifier_id);
      assert.deepStrictEqual(revisionBindingProofErrors(receipt), []);

      // Unchanged workspace stays fresh
      refreshChatVerifierReceiptStalenessSync(tempDir, receipt);
      assert.strictEqual(receipt.stale, false);

      await fs.writeFile(path.join(tempDir, rel), 'v2');
      refreshChatVerifierReceiptStalenessSync(tempDir, receipt);
      assert.strictEqual(receipt.stale, true);
      assert.match(receipt.staleReason ?? '', /File modified after verification/);

      const honesty = evaluateExecuteCompletionHonesty({
        hasWrite: true,
        policy: 'required',
        lastVerifierReceipt: receipt,
        toolCallLog: [
          { tool: 'write_file', target: rel },
          { tool: 'run_command', target: 'npm test', exit_code: 0 },
        ],
      });
      assert.strictEqual(honesty.allow, false);
      assert.strictEqual(honesty.reason, 'verifier_stale');
      assert.ok(revisionBindingProofErrors(receipt).some((e) => /stale/.test(e)));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('toRevisionBoundReceipt requires boundRevision', async () => {
    assert.strictEqual(
      toRevisionBoundReceipt({
        command: 'npm test',
        exit_code: 0,
        summary: 'ok',
      }),
      null,
    );
  });

  it('builds evidence graph and evaluateEvidence rejects stale bound receipt', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-chat-ev-'));
    try {
      const rel = 'src/mod.ts';
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tempDir, rel), 'v1');

      const receipt = await bindChatVerifierReceipt({
        projectRoot: tempDir,
        command: 'npm test',
        exit_code: 0,
        summary: 'ok',
        mutationPaths: [rel],
        structured: {
          verifierId: 'npm-test',
          authoritySource: 'built_in_runner',
          executable: 'npm',
          args: ['test'],
        },
      });

      const events = [
        { kind: 'mutation_batch' as const, paths: [rel] },
        {
          kind: 'verifier_attempt' as const,
          authoritative: true,
          exit_code: 0,
        },
      ];

      const fresh = evaluateChatEvidenceGraph({
        projectRoot: tempDir,
        receipt,
        events,
        hasMutation: true,
      });
      assert.strictEqual(fresh.compliant, true);

      // Kernel sync twin agrees with helper
      const graph = buildChatEvidenceGraph({
        receipt,
        mutationPaths: [rel],
        hasMutation: true,
      });
      const kernel = createExecutorKernel('chat');
      const viaKernel = kernel.completion.evaluateEvidenceSync({
        projectRoot: tempDir,
        graph,
        contract: {
          taskClaimId: CHAT_EVIDENCE_CLAIM_ID,
          requiredEvidenceTypes: ['patch', 'verifier_receipt'],
        },
      });
      assert.strictEqual(viaKernel.compliant, true);

      await fs.writeFile(path.join(tempDir, rel), 'v2');
      const stale = evaluateChatEvidenceGraph({
        projectRoot: tempDir,
        receipt,
        events,
        hasMutation: true,
      });
      assert.strictEqual(stale.compliant, false);
      assert.ok(stale.errors.some((e) => /Stale receipt/i.test(e)));

      const proof = evaluateChatCompletionProof({
        projectRoot: tempDir,
        hasMutation: true,
        verifierTampered: false,
        receipt,
        events,
        isAuthoritativeCommand: () => true,
        // Keep IndependentVerifier off so this case only asserts staleness.
        env: {},
        executionProfile: 'safe_repo',
      });
      assert.strictEqual(proof.compliant, false);
      assert.ok(proof.errors?.some((e) => /Stale receipt|stale/i.test(e)));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('evaluateChatCompletionProof enables clean-room IV from high-assurance profile default', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-chat-iv-profile-'));
    try {
      const rel = 'src/mod.ts';
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tempDir, rel), 'v1');

      const receipt = await bindChatVerifierReceipt({
        projectRoot: tempDir,
        command: 'node -e "process.exit(1)"',
        exit_code: 0,
        summary: 'primary green',
        mutationPaths: [rel],
        structured: {
          verifierId: 'node-exit',
          authoritySource: 'built_in_runner',
          executable: 'node',
          args: ['-e', 'process.exit(1)'],
        },
      });

      const events = [
        { kind: 'mutation_batch' as const, paths: [rel] },
        {
          kind: 'verifier_attempt' as const,
          authoritative: true,
          exit_code: 0,
        },
      ];

      // env unset for BABEL_INDEPENDENT_VERIFIER; profile default should opt in
      const proof = evaluateChatCompletionProof({
        projectRoot: tempDir,
        hasMutation: true,
        verifierTampered: false,
        receipt,
        events,
        isAuthoritativeCommand: () => true,
        env: {},
        executionProfile: 'benchmark_container',
      });
      assert.strictEqual(proof.compliant, false);
      assert.ok(
        proof.errors?.some((e) => /independent clean-room verifier failed/i.test(e)),
        `expected clean-room failure, got: ${proof.errors?.join('; ')}`,
      );

      // same setup with everyday profile: no clean-room path
      const everyday = evaluateChatCompletionProof({
        projectRoot: tempDir,
        hasMutation: true,
        verifierTampered: false,
        receipt,
        events,
        isAuthoritativeCommand: () => true,
        env: {},
        executionProfile: 'safe_repo',
      });
      assert.ok(
        !everyday.errors?.some((e) => /independent clean-room/i.test(e)),
        'safe_repo must not enable clean-room IndependentVerifier by default',
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
