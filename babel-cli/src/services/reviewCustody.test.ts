import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ─── Architectural custody boundary (mission Phase 15) ───────────────────────
//
// Builder-facing modules may request review, send exact candidate data,
// receive verdicts/attestations/receipts, and ask the base-rooted verifier for
// status. They must NEVER import or construct private-key-backed signing
// authority. This source scan fails if the boundary regresses.

const serviceRoot = join(process.cwd(), 'src', 'services');

/** Modules allowed to reference authority construction (definition sites and test-only code). */
const ALLOWED_AUTHORITY_REFERENCES = new Set(
  [
    'src/evidence/independentReview.ts', // defines createIndependentReviewAuthorityV1 (the authority factory)
    'src/services/reviewTrustedAuthority.ts', // trusted-service-only construction wrapper (definition site)
    'src/services/trustedReviewIssuer.test.ts', // trusted service exercising the wrapper/factory
    'src/agent/autonomousSweHardening.test.ts', // test-only fixture keys
    'src/services/reviewCustody.test.ts', // this custody test (documents the forbidden symbols)
  ],
);

function listTsFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const AUTHORITY_SYMBOLS = [
  'createFileBackedTrustedReviewAuthority',
  'createIndependentReviewAuthorityV1',
];

/** Import of the trusted authority module (any relative depth). */
const AUTHORITY_MODULE_IMPORT = /from\s+'[^']*reviewTrustedAuthority[^']*'/;

/** Actual call sites of authority construction (definitions excluded). */
function authorityCallSites(text: string): string[] {
  return AUTHORITY_SYMBOLS.filter((symbol) =>
    new RegExp(`\\b${symbol}\\s*\\(`).test(text),
  );
}

const BUILDER_FACING_ROOTS = [join('src', 'services'), join('src', 'commands'), join('src', 'agent')];

test('builder-facing modules never import or construct trusted signing authority', () => {
  const violations: string[] = [];
  for (const root of BUILDER_FACING_ROOTS) {
    for (const file of listTsFiles(join(process.cwd(), root))) {
      const rel = relative(process.cwd(), file).replaceAll('\\', '/');
      if (ALLOWED_AUTHORITY_REFERENCES.has(rel)) continue;
      const text = readFileSync(file, 'utf-8');
      if (AUTHORITY_MODULE_IMPORT.test(text)) violations.push(`${rel} imports the trusted authority module`);
      for (const symbol of authorityCallSites(text)) {
        violations.push(`${rel} calls ${symbol}()`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Builder-facing modules must not reference trusted authority construction:\n${violations.join('\n')}`,
  );
});

test('the builder-facing issuer no longer exports authority construction', () => {
  const issuer = readFileSync(join(serviceRoot, 'trustedReviewIssuer.ts'), 'utf-8');
  // Assert on export/import declarations, not prose mentions of the symbol.
  assert.ok(!/export\s+(async\s+)?(function|const)\s+createFileBackedTrustedReviewAuthority/.test(issuer), 'issuer must not export the file-backed authority wrapper');
  assert.ok(!/import\s+\{[^}]*createIndependentReviewAuthorityV1/.test(issuer), 'issuer must not import the authority factory');
});

test('the trusted authority module declares its custody boundary and stays import-isolated', () => {
  const trusted = readFileSync(join(serviceRoot, 'reviewTrustedAuthority.ts'), 'utf-8');
  assert.match(trusted, /TRUSTED SERVICE ONLY/);
  // The wrapper must not be re-exported from any barrel that builder code imports.
  const index = join(serviceRoot, 'index.ts');
  try {
    const indexText = readFileSync(index, 'utf-8');
    assert.ok(!indexText.includes('reviewTrustedAuthority'), 'trusted authority must not be re-exported from services barrel');
  } catch {
    // No barrel present — nothing to assert.
  }
});
