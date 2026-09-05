import { spawn } from 'node:child_process';

import type { IndependentReviewReceiptV2 } from '../evidence/independentReview.js';
import type { IndependentReviewCandidate, IndependentReviewVerdict, TrustedReviewIssuer, TrustedReviewVerifier } from './independentReviewBroker.js';
import type { ReviewExecutionAttestation } from './reviewProvenance.js';

export interface JsonServiceCommand {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export function runJsonService<T>(service: JsonServiceCommand, input: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(service.command, service.args ?? [], {
      cwd: service.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('Trusted review service timed out.'));
      }
    }, service.timeoutMs ?? 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Trusted review service could not be started.'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Trusted review service exited with code ${code ?? 'unknown'}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error('Trusted review service returned invalid JSON.'));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export function createProcessAttestationSigner(service: JsonServiceCommand): (input: Omit<ReviewExecutionAttestation, 'signature'>) => Promise<ReviewExecutionAttestation> {
  return (input) => runJsonService<ReviewExecutionAttestation>(service, input);
}

/** Process boundary for the reviewer/supervisor authority lane. The builder receives only the signed receipt. */
export function createProcessTrustedReviewIssuer(service: JsonServiceCommand): TrustedReviewIssuer {
  return {
    certify: (input: {
      candidate: IndependentReviewCandidate;
      verdict: IndependentReviewVerdict;
      provenance: ReviewExecutionAttestation;
      reviewer_class: 'independent_readonly' | 'independent_breaker';
      review_mode: 'exact_head' | 'exact_revision';
    }): Promise<IndependentReviewReceiptV2> => runJsonService<IndependentReviewReceiptV2>(service, input),
  };
}

export function createProcessTrustedReviewVerifier(service: JsonServiceCommand): TrustedReviewVerifier {
  return {
    verify: (input: { candidate: IndependentReviewCandidate; receipt: IndependentReviewReceiptV2 }) =>
      runJsonService<{ passed: boolean; errors?: string[] }>(service, input),
  };
}
