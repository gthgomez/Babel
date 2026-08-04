import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bindChatVerifierReceipt,
  mutationPathsFromSessionEvents,
  refreshChatVerifierReceiptStalenessSync,
  revisionBindingProofErrors,
  toRevisionBoundReceipt,
} from './chatRevisionBinding.js';
import { evaluateExecuteCompletionHonesty } from '../agent/completionGatePolicy.js';

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
});
