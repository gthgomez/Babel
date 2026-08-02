import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseStructuredVerifierCommand, isAuthoritativeVerifierCommand } from '../agent/completionGatePolicy.js';
import { RevisionBoundReceipt, RevisionManager } from './revisionBoundReceipt.js';

export class IndependentVerifier {
  static async runIsolatedVerification(
    projectRoot: string,
    command: string,
    touchedFiles: string[]
  ): Promise<RevisionBoundReceipt> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-verify-'));

    try {
      await fs.cp(projectRoot, tempDir, {
        recursive: true,
        filter: (src) => {
          const normalized = src.replace(/\\/g, '/').toLowerCase();
          const base = path.basename(normalized);
          return !normalized.includes('/node_modules/')
            && !normalized.includes('/.git/')
            && !base.startsWith('.env')
            && !base.endsWith('.pem')
            && !base.endsWith('.key');
        },
      });

      const boundRevision = await RevisionManager.computeRevision(projectRoot, touchedFiles);
      const structured = parseStructuredVerifierCommand(command);
      const authority = isAuthoritativeVerifierCommand(command);
      let exitCode = 0;
      if (!structured) {
        exitCode = 126;
      } else {
        try {
          execFileSync(structured.executable, structured.args, {
            cwd: tempDir,
            stdio: 'ignore',
            timeout: 120_000,
            windowsHide: true,
          });
        } catch (err: any) {
          exitCode = err.status || 1;
        }
      }

      return {
        receiptId: `receipt-${Date.now()}`,
        command,
        exitCode,
        boundRevision,
        stale: false,
        authority,
        authoritySource: 'unknown',
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
