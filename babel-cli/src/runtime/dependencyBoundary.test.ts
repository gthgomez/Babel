/**
 * P03 — dependency boundary guard.
 *
 * The runtime facade must stay renderer-independent and must not become a
 * Prompt OS/authority layer. These checks are source-level on purpose: an
 * import edge is the cheapest way for UI or prompt compilation to leak into
 * runtime.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_FILES = [
  'contracts.ts',
  'coordinator.ts',
  'events.ts',
  'canonical.ts',
  'projection.ts',
  'legacyEventAdapters.ts',
  'admission.ts',
  'admissionContracts.ts',
  'admissionTestHooks.ts',
  'adapters/chat.ts',
  'adapters/plan.ts',
  'adapters/deep.ts',
  'adapters/index.ts',
];

/** Substrings that must never appear in a runtime import specifier. */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  '/ui/',
  '/interactive/',
  'waterfall',
  'ConversationalRenderer',
  'historyCells',
  'chatStackCompile',
  'compileChatStack',
];

/** Modules whose behaviour must not be owned or re-implemented by runtime. */
const FORBIDDEN_AUTHORITY_IMPORTS = [
  'completionGatePolicy',
  'requiredVerifierContract',
  'compiler.js',
  'intentCompiler',
];

function readRuntime(rel: string): string {
  return readFileSync(path.join(HERE, rel), 'utf8');
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

test('P03: runtime facade never imports renderer/UI modules', () => {
  for (const rel of RUNTIME_FILES) {
    const specifiers = importSpecifiers(readRuntime(rel));
    for (const specifier of specifiers) {
      for (const forbidden of FORBIDDEN_IMPORT_FRAGMENTS) {
        assert.ok(
          !specifier.includes(forbidden),
          `${rel} must not import renderer/UI dependency "${specifier}"`,
        );
      }
    }
  }
});

test('P03: runtime facade does not own completion/verifier/prompt authority', () => {
  for (const rel of RUNTIME_FILES) {
    const specifiers = importSpecifiers(readRuntime(rel));
    for (const specifier of specifiers) {
      for (const forbidden of FORBIDDEN_AUTHORITY_IMPORTS) {
        assert.ok(
          !specifier.includes(forbidden),
          `${rel} must not import authority module "${specifier}"`,
        );
      }
    }
  }
});

test('P05: runtime admission never imports the permission-decision path', () => {
  for (const rel of RUNTIME_FILES) {
    for (const specifier of importSpecifiers(readRuntime(rel))) {
      assert.ok(
        !specifier.includes('/authority/'),
        `${rel} must not import the permission-decision path "${specifier}"`,
      );
    }
  }
});

test('P03: coordinator reuses the P02 PreparedTurn/mode-capability contract', () => {
  const coordinator = readRuntime('coordinator.ts');
  assert.match(coordinator, /buildPreparedTurn/);
  assert.match(coordinator, /resolveModeCapability/);
  assert.match(coordinator, /executor\/modeAdapters\.js/);
});

test('P03: adapters route to executor mode semantics rather than inventing policy', () => {
  const chat = readRuntime('adapters/chat.ts');
  const plan = readRuntime('adapters/plan.ts');
  const deep = readRuntime('adapters/deep.ts');
  assert.match(chat, /resolveModeCapability\('chat'\)/);
  assert.match(plan, /resolveModeCapability\('plan'\)/);
  assert.match(plan, /modePolicyFor\('plan'\)/);
  assert.match(deep, /resolveModeCapability\('deep'\)/);
  assert.match(deep, /RuntimeModeUnsupportedError/);
});
