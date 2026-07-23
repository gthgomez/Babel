import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildSecretScanReport,
  scanDiffForSecrets,
  scanTextForSecrets,
  secretFindingsToHardStopMessages,
} from './shipSecretScan.js';

describe('shipSecretScan (W3.1)', () => {
  test('detects private key and github pat in text', () => {
    const findings = scanTextForSecrets(
      ['-----BEGIN RSA PRIVATE KEY-----', 'ghp_abcdefghijklmnopqrstuvwxyz123456'].join('\n'),
      'secrets.txt',
    );
    assert.ok(findings.some((f) => f.rule === 'private_key_block'));
    assert.ok(findings.some((f) => f.rule === 'github_pat'));
  });

  test('scans only added lines in unified diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-old ghp_UNITTEST_REMOVED_ONLY_FAKE',
      '+const t = "ghp_UNITTEST_ONLY_FAKE_TOKEN_XXXX";',
    ].join('\n');
    const findings = scanDiffForSecrets(diff);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.path, 'a.ts');
    assert.equal(findings[0]!.rule, 'github_pat');
  });

  test('report fails when findings present; hard-stop messages redact', () => {
    const findings = scanTextForSecrets('api_key = "supersecretvalue123"', 'cfg.ts');
    const report = buildSecretScanReport(findings);
    assert.equal(report.passed, false);
    const stops = secretFindingsToHardStopMessages(findings);
    assert.equal(stops[0]!.code, 'secret_content_scan');
    assert.ok(!stops[0]!.message.includes('supersecretvalue123'));
  });

  test('placeholder lines are skipped', () => {
    const findings = scanTextForSecrets('api_key = "YOUR_API_KEY_HERE_PLACEHOLDER"', 'cfg.ts');
    assert.equal(findings.length, 0);
  });
});
