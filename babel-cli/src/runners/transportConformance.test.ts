/**
 * transportConformance.test.ts — P0-E transport conformance (structural).
 *
 * Makes the provider authority certification in providerRegistry.ts DERIVED:
 * `authorityConformance: 'certified'` must be backed by structural evidence
 * demonstrated here, not asserted by hand. Pure code-structure inspection plus
 * synthetic module fixtures — no real credentials, no network, no spend, no
 * real repositories.
 *
 * The invariant under test ("no alternate effectful path"):
 *   provider transport → effect (tool call, shell, file write, network) must
 *   ALWAYS land on Babel's authority boundary (executeActionWithPolicy in
 *   agent/toolExecutor.ts, or the executor kernel that dispatches through it)
 *   and NEVER on a direct effect (child_process spawn, raw fs write, raw fetch)
 *   smuggled past the boundary.
 *
 * Lane map verified by this suite:
 *   API transports (providerEngine.ts + protocol adapters)
 *     → structured JSON actions / tool_use stream events
 *     → agent lane (chatEngine.ts) → executeActionWithPolicy → executeTool.
 *   Kernel dispatcher (executor/kernel.ts)
 *     → ToolCallRequest → AgentAction → executeActionWithPolicy.
 *   CLI transports (cliBase/claudeCli/codexCli/geminiCli + structuredRunner)
 *     → legacy public-use fallback only; spawn provider binaries through the
 *     single choke point cliBase.spawnCliProcess; GAPs documented below.
 *
 * Certification derivation (see 'certification is derived' test):
 *   the registry-certified set must EQUAL the structurally-vetted set declared
 *   in this file. A future 'certified' claim without evidence entries fails;
 *   evidence entries without the registry flag fail. Dormant providers must
 *   stay 'untested' until their transport passes every check here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExecutorKernel } from '../executor/kernel.js';
import type { ToolContext } from '../localTools.js';
import {
  getProviderSpec,
  listProviderSpecs,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderOperation,
  type ProviderProtocol,
} from './providerRegistry.js';
import { RogueTransport } from './transportConformance.fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNERS_DIR = HERE;
const SRC_DIR = path.resolve(RUNNERS_DIR, '..');

// ─── Transport surface inventory ─────────────────────────────────────────────

/**
 * API transports: the engine and its protocol adapters. These are the only
 * modules a certified provider may be driven through. The strict raw-effect
 * scan (no child_process / fs / sockets) applies to this set.
 */
const API_TRANSPORT_MODULES = [
  'providerEngine.ts',
  'apiFallback.ts',
  'deepSeekApi.ts',
  'deepInfraApi.ts',
  'ollamaApi.ts',
  'openAiApi.ts',
  'geminiApi.ts',
  'groqApi.js',
  'openRouterApi.ts',
  'openCodeApi.ts',
  'providerMessages.ts',
  'providerNormalize.ts',
  'credentialHub.ts',
  'base.ts',
] as const;

/**
 * CLI transports: legacy public-use fallback runners. They spawn provider CLI
 * binaries through cliBase.spawnCliProcess (the single sanctioned spawn site).
 */
const CLI_TRANSPORT_MODULES = [
  'cliBase.ts',
  'claudeCli.ts',
  'codexCli.ts',
  'geminiCli.ts',
  'structuredRunner.ts',
] as const;

/** Raw effect primitives an API transport must never reach. */
const BANNED_RAW_EFFECT_SPECIFIERS = [
  'node:child_process',
  'node:fs',
  'node:net',
  'node:vm',
  'node:worker_threads',
  'node:cluster',
] as const;

/** Call sites that would execute a raw effect inside a transport module. */
const RAW_EFFECT_CALL_PATTERNS: readonly RegExp[] = [
  /\bspawn\s*\(/,
  /\bspawnSync\s*\(/,
  /\bexec\s*\(/,
  /\bexecSync\s*\(/,
  /\bexecFile\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bwriteFile\s*\(/,
  /\bwriteFileSync\s*\(/,
  /\bappendFile\s*\(/,
  /\bappendFileSync\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\brmSync\s*\(/,
  /\bmkdirSync\s*\(/,
  /\bmkdtempSync\s*\(/,
  /\bunlinkSync\s*\(/,
  /\bcreateServer\s*\(/,
];

/** Provider → adapter module + class, for every registered provider. */
const ADAPTER_INDEX: Readonly<Record<ProviderId, { module: string; adapterClass: string }>> = {
  deepseek: { module: 'deepSeekApi.ts', adapterClass: 'DeepSeekApiRunner' },
  deepinfra: { module: 'deepInfraApi.ts', adapterClass: 'DeepInfraApiRunner' },
  openrouter: { module: 'openRouterApi.ts', adapterClass: 'OpenRouterApiRunner' },
  opencode: { module: 'openCodeApi.ts', adapterClass: 'OpenCodeApiRunner' },
  openai: { module: 'openAiApi.ts', adapterClass: 'OpenAiApiRunner' },
  anthropic: { module: 'apiFallback.ts', adapterClass: 'ApiFallbackRunner' },
  gemini: { module: 'geminiApi.ts', adapterClass: 'GeminiApiRunner' },
  groq: { module: 'groqApi.js', adapterClass: 'GroqApiRunner' },
  ollama: { module: 'ollamaApi.ts', adapterClass: 'OllamaApiRunner' },
};

const ADAPTER_MODULE_OF_CLASS: Readonly<Record<string, { module: string }>> = Object.fromEntries(
  Object.values(ADAPTER_INDEX).map((entry) => [entry.adapterClass, { module: entry.module }]),
);

/** Adapter inheritance (OpenRouter/Ollama/OpenCode inherit the DeepInfra implementation). */
const CLASS_EXTENDS: Readonly<Record<string, string | null>> = {
  DeepSeekApiRunner: null,
  DeepInfraApiRunner: null,
  OllamaApiRunner: 'DeepInfraApiRunner',
  OpenRouterApiRunner: 'DeepInfraApiRunner',
  OpenCodeApiRunner: 'DeepInfraApiRunner',
  OpenAiApiRunner: null,
  GeminiApiRunner: null,
  ApiFallbackRunner: null,
  GroqApiRunner: null,
};

/** Registry operation → method that must exist on the adapter (or its base). */
const OPERATION_METHOD: Readonly<Record<ProviderOperation, RegExp>> = {
  // `execute<T>(` — allow an optional generic clause between name and parens.
  structured: /\bexecute(?:<[^>]*>)?\s*\(/,
  raw: /\bexecuteRaw(?:<[^>]*>)?\s*\(/,
  raw_stream: /\bexecuteRawStream(?:<[^>]*>)?\s*\(/,
  native_tool_stream: /\bexecuteWithToolsStream(?:<[^>]*>)?\s*\(/,
};

/**
 * The structurally-vetted set. Certification is DERIVED: the registry's
 * certified set must equal this set exactly, and every entry must pass every
 * structural check below. Certifying a new provider means adding it here AND
 * to ADAPTER_INDEX AND wiring it in providerEngine.ts — all enforced.
 */
const EVIDENCE_VETTED_PROVIDERS: readonly ProviderId[] = ['deepseek', 'deepinfra', 'ollama', 'openrouter'];

/** Independent evidence record — registry claims must agree with it. */
const EVIDENCE_EXPECTATIONS: Readonly<
  Record<ProviderId, { protocol: ProviderProtocol; requiresCredential: boolean }>
> = {
  deepseek: { protocol: 'deepseek', requiresCredential: true },
  deepinfra: { protocol: 'openai_compatible', requiresCredential: true },
  ollama: { protocol: 'ollama', requiresCredential: false },
  openrouter: { protocol: 'openai_compatible', requiresCredential: true },
  // Dormant providers carry no evidence expectations until they are vetted.
  opencode: { protocol: 'openai_compatible', requiresCredential: true },
  openai: { protocol: 'openai_compatible', requiresCredential: true },
  anthropic: { protocol: 'anthropic', requiresCredential: true },
  gemini: { protocol: 'gemini', requiresCredential: true },
  groq: { protocol: 'groq', requiresCredential: true },
};

// ─── Structural scanning helpers ─────────────────────────────────────────────

function readTransportSource(relFile: string): string {
  const full = path.join(RUNNERS_DIR, relFile);
  assert.ok(existsSync(full), `transport module missing: ${relFile}`);
  return readFileSync(full, 'utf8');
}

/** Extract every import specifier (static from-clauses + dynamic imports). */
function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\bfrom\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) specifiers.push(m[1]!);
  while ((m = dynamicRe.exec(source)) !== null) specifiers.push(m[1]!);
  return specifiers;
}

/** Resolve a relative specifier to a normalized absolute path; bare → as-is. */
function resolveSpecifier(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  const fromDir = path.dirname(path.join(RUNNERS_DIR, file));
  return path.resolve(fromDir, spec).replace(/\.(?:ts|js|mjs|cjs)$/, '');
}

const EFFECT_SINK = path.resolve(RUNNERS_DIR, '..', 'localTools');
const BOUNDARY = path.resolve(RUNNERS_DIR, '..', 'agent', 'toolExecutor');

/**
 * Boundary-reach scan: a transport must never import the effect sink
 * (localTools) or the authority boundary itself (toolExecutor), nor reference
 * their identifiers. Transports pass effects FORWARD as actions/events; they
 * never execute or consume them directly.
 */
function scanBoundaryReach(source: string, file: string): string[] {
  const violations: string[] = [];
  for (const spec of collectImportSpecifiers(source)) {
    if (!spec.startsWith('.')) continue;
    const resolved = resolveSpecifier(file, spec);
    if (resolved === EFFECT_SINK) {
      violations.push(`imports the effect sink directly: '${spec}'`);
    }
    if (resolved === BOUNDARY) {
      violations.push(`imports the authority boundary directly: '${spec}'`);
    }
  }
  if (/\bexecuteTool\b/.test(source)) {
    violations.push('references the effect-sink identifier executeTool');
  }
  if (/\bexecuteActionWithPolicy\b/.test(source)) {
    violations.push('references the authority boundary identifier executeActionWithPolicy');
  }
  return violations;
}

/**
 * Raw-effect scan: an API transport must not import raw effect primitives
 * (process spawn, fs write, sockets, workers, VM) nor call them.
 */
function scanRawEffectPrimitives(source: string, file: string): string[] {
  const violations: string[] = [];
  for (const spec of collectImportSpecifiers(source)) {
    if ((BANNED_RAW_EFFECT_SPECIFIERS as readonly string[]).includes(spec)) {
      violations.push(`raw effect import: '${spec}'`);
    }
  }
  for (const pattern of RAW_EFFECT_CALL_PATTERNS) {
    if (pattern.test(source)) violations.push(`raw effect call site: ${pattern}`);
  }
  return violations;
}

/** Walk the adapter inheritance chain; true when the operation is implemented. */
function methodImplemented(adapterClass: string, op: ProviderOperation): boolean {
  let current: string | null | undefined = adapterClass;
  while (current) {
    const moduleOf = ADAPTER_MODULE_OF_CLASS[current];
    assert.ok(moduleOf, `adapter class ${current} missing from class→module map`);
    if (OPERATION_METHOD[op].test(readTransportSource(moduleOf.module))) return true;
    current = CLASS_EXTENDS[current];
  }
  return false;
}

/** Every non-test, non-fixture module in the transport directory. */
function listTransportFiles(): string[] {
  return readdirSync(RUNNERS_DIR)
    .filter((f) => /\.(ts|js)$/.test(f))
    .filter((f) => !f.endsWith('.test.ts'))
    .filter((f) => !f.includes('.fixture.'));
}

// ─── No alternate effectful path: transport → boundary only ──────────────────

test('transport: no module in src/runners reaches the effect sink or the authority boundary directly', () => {
  for (const file of listTransportFiles()) {
    const violations = scanBoundaryReach(readTransportSource(file), file);
    assert.deepEqual(
      violations,
      [],
      `${file} must never reach effects past the authority boundary`,
    );
  }
});

test('transport: API transports never import or call raw effect primitives', () => {
  for (const file of API_TRANSPORT_MODULES) {
    const violations = scanRawEffectPrimitives(readTransportSource(file), file);
    assert.deepEqual(violations, [], `${file} must be effect-free except its provider API call`);
  }
});

test('transport: all process creation in the transport layer funnels through cliBase.spawnCliProcess', () => {
  const importers = listTransportFiles().filter((file) =>
    collectImportSpecifiers(readTransportSource(file)).includes('node:child_process'),
  );
  // cliBase.ts is the SINGLE sanctioned spawn site; CLI runners go through it.
  assert.deepEqual(importers, ['cliBase.ts']);
  assert.match(readTransportSource('cliBase.ts'), /export function spawnCliProcess/);
  for (const cli of ['claudeCli.ts', 'codexCli.ts', 'geminiCli.ts']) {
    const source = readTransportSource(cli);
    assert.match(source, /spawnCliProcess/, `${cli} must spawn through cliBase`);
    assert.doesNotMatch(source, /node:child_process/, `${cli} must not spawn directly`);
  }
});

test('transport: transports only EMIT tool_use events — the agent lane executes them', () => {
  for (const file of [...API_TRANSPORT_MODULES, ...CLI_TRANSPORT_MODULES]) {
    assert.doesNotMatch(
      readTransportSource(file),
      /case 'tool_use'/,
      `${file} must not execute tool_use events itself`,
    );
  }
  const chatEngine = readFileSync(path.join(SRC_DIR, 'agent', 'chatEngine.ts'), 'utf8');
  assert.match(chatEngine, /case 'tool_use'/, 'agent lane consumes tool_use events');
  assert.match(chatEngine, /executeActionWithPolicy/, 'agent lane dispatches through the boundary');
});

// ─── Registry ↔ implementation coherence ────────────────────────────────────

test('transport: ProviderEngine wires every registered provider to its adapter', () => {
  const engine = readTransportSource('providerEngine.ts');
  for (const provider of PROVIDER_IDS) {
    const entry = ADAPTER_INDEX[provider]!;
    assert.match(engine, new RegExp(`case '${provider}':`), `engine switch missing ${provider}`);
    assert.match(
      engine,
      new RegExp(`new ${entry.adapterClass}\\s*\\(`),
      `engine switch does not construct ${entry.adapterClass} for ${provider}`,
    );
  }
});

test('transport: registry-declared operations are implemented by the adapter (incl. inheritance)', () => {
  for (const provider of PROVIDER_IDS) {
    const spec = getProviderSpec(provider);
    const entry = ADAPTER_INDEX[provider]!;
    assert.ok(
      existsSync(path.join(RUNNERS_DIR, entry.module)),
      `${provider} adapter module missing: ${entry.module}`,
    );
    assert.match(
      readTransportSource(entry.module),
      new RegExp(`export class ${entry.adapterClass}\\b`),
      `${entry.module} must export ${entry.adapterClass}`,
    );
    for (const op of spec.operations) {
      assert.ok(
        methodImplemented(entry.adapterClass, op),
        `${provider} declares operation '${op}' but no adapter (or base) implements it`,
      );
    }
  }
});

test('transport: registry provider list matches the adapter index exactly', () => {
  const indexed = Object.keys(ADAPTER_INDEX).sort();
  const registered = [...PROVIDER_IDS].sort();
  assert.deepEqual(indexed, registered, 'ADAPTER_INDEX must cover every registered provider');
});

// ─── Certification is derived from structural evidence (P0-E) ───────────────

test('transport: authority certification is derived from structural evidence', () => {
  const certified = listProviderSpecs()
    .filter((s) => s.authorityConformance === 'certified')
    .map((s) => s.id)
    .sort();
  assert.deepEqual(
    certified,
    [...EVIDENCE_VETTED_PROVIDERS].sort(),
    'certified set must equal the structurally-vetted set — certify only with evidence',
  );

  // Every vetted provider must demonstrably satisfy every structural check.
  const engine = readTransportSource('providerEngine.ts');
  for (const provider of EVIDENCE_VETTED_PROVIDERS) {
    const spec = getProviderSpec(provider);
    const entry = ADAPTER_INDEX[provider]!;
    const expectations = EVIDENCE_EXPECTATIONS[provider]!;
    assert.equal(spec.protocol, expectations.protocol, `${provider} protocol mismatch`);
    assert.equal(
      spec.requiresCredential,
      expectations.requiresCredential,
      `${provider} credential requirement mismatch`,
    );
    assert.equal(spec.authorityConformance, 'certified');

    const source = readTransportSource(entry.module);
    assert.deepEqual(scanBoundaryReach(source, entry.module), [], `${provider} boundary reach`);
    assert.deepEqual(
      scanRawEffectPrimitives(source, entry.module),
      [],
      `${provider} raw effect primitives`,
    );
    for (const op of spec.operations) {
      assert.ok(
        methodImplemented(entry.adapterClass, op),
        `${provider} lacks implementation for declared operation '${op}'`,
      );
    }
  }

  // Credential-free provider must never receive a credential at construction.
  assert.match(
    engine,
    /new OllamaApiRunner\(\s*options\.modelId\s*\)/,
    'ollama (credential-free) must be constructed without a credential',
  );

  // Dormant providers must NOT be certified without structural evidence.
  for (const provider of PROVIDER_IDS) {
    if ((EVIDENCE_VETTED_PROVIDERS as readonly string[]).includes(provider)) continue;
    assert.equal(
      getProviderSpec(provider).authorityConformance,
      'untested',
      `${provider} must stay untested until its transport passes this suite`,
    );
  }
});

// ─── Kernel dispatcher: every effectful ToolCallRequest hits the boundary ────

test('transport: kernel dispatcher routes every effectful ToolCallRequest through the authority boundary', async () => {
  const kernel = createExecutorKernel('chat');
  let seq = 0;
  const freshCtx = (): ToolContext => ({
    agentId: 'transport-conformance',
    runId: `transport-conformance-${++seq}`,
    babelRoot: process.cwd(),
  });

  // Credential dump — intercepted by the boundary (CLASS_D) BEFORE any shell runs.
  const credentialDump = await kernel.tools.execute(
    { tool: 'shell_exec', command: 'cat .env' },
    freshCtx(),
  );
  assert.equal(credentialDump.exit_code, 1);
  assert.match(credentialDump.stderr, /AUTONOMY_DENIED:CLASS_D/);

  // Credential write — intercepted by the boundary BEFORE any fs write.
  const credentialWrite = await kernel.tools.execute(
    { tool: 'file_write', path: '.env', content: 'x' },
    freshCtx(),
  );
  assert.equal(credentialWrite.exit_code, 1);
  assert.match(credentialWrite.stderr, /AUTONOMY_DENIED/);

  // Destructive/external push — missing privileged authority denies headless.
  const forcePush = await kernel.tools.execute(
    { tool: 'shell_exec', command: 'git push --force origin main' },
    freshCtx(),
  );
  assert.equal(forcePush.exit_code, 1);
  assert.match(forcePush.stderr, /DENY_|AUTONOMY_DENIED|Policy denied/);

  // Model-directed network intent — denied at the boundary; no network occurs.
  const networkIntent = await kernel.tools.execute(
    { tool: 'shell_exec', command: 'curl -s https://example.com' },
    freshCtx(),
  );
  assert.equal(networkIntent.exit_code, 1);
  assert.match(networkIntent.stderr, /denied/i);

  // Allowed probe: passes the boundary (no denial marker) and reaches the tool
  // lane, failing only because the synthetic target does not exist.
  const allowed = await kernel.tools.execute(
    { tool: 'file_read', path: 'babel-transport-conformance-no-such-file.tmp' },
    freshCtx(),
  );
  assert.notEqual(allowed.exit_code, 0);
  assert.doesNotMatch(allowed.stderr, /denied/i);
});

// ─── CLI transports: residual risks pinned + GAP ledger ─────────────────────

test('transport: codex CLI runs in full-auto mode (factual basis of GAP-1, pinned)', () => {
  // Pins the factual basis of GAP-1 below. If GAP-1 is ever closed (spawn
  // argv without self-execution), this assertion must be inverted and the
  // GAP marker removed — the flip is intentionally fail-loud.
  assert.match(readTransportSource('codexCli.ts'), /--full-auto/);
});

test('transport: codex prompt staging stays outside the workspace (tmpdir only)', () => {
  const codex = readTransportSource('codexCli.ts');
  assert.match(codex, /from 'node:os'/, 'codex prompt staging must use os.tmpdir');
  assert.match(codex, /mkdtempSync\(join\(tmpdir\(\)/, 'staging dir must be under os.tmpdir()');
});

// ─── Negative control: the scanner must catch a deliberately-rogue transport ─

test('transport: the structural scanner catches a deliberately-rogue transport (negative control)', () => {
  const fixture = readTransportSource('transportConformance.fixture.ts');
  const reach = scanBoundaryReach(fixture, 'transportConformance.fixture.ts');
  const primitives = scanRawEffectPrimitives(fixture, 'transportConformance.fixture.ts');
  assert.ok(
    reach.length >= 2,
    `fixture must trip the boundary-reach scan (got: ${reach.join('; ') || 'none'})`,
  );
  assert.ok(
    primitives.length >= 2,
    `fixture must trip the raw-effect scan (got: ${primitives.join('; ') || 'none'})`,
  );
  assert.equal(typeof RogueTransport, 'function', 'fixture must load as a real module');
});

// ─── GAP ledger — explicitly documented structural limits ────────────────────
// These are NOT live assertions; each carries a 'GAP' marker so a future change
// that closes a gap is a deliberate, reviewable edit.

// GAP-1 (CLI self-execution — cannot be enforced structurally):
//   codexCli.ts spawns `codex exec --full-auto`. In full-auto mode the Codex
//   CLI retains its OWN tool-execution capability: tools the spawned CLI
//   executes itself are NOT routed through executeActionWithPolicy, so Babel's
//   authority boundary cannot intercept them. The only mitigations are
//   prompt-level (NEUTER_PREAMBLE: "You are in READ-ONLY mode. Do NOT execute
//   any tools") and process-level (stdinMode: 'ignore' prevents approval
//   prompts), neither of which is a structural guarantee.
//   Consequence: NO provider may be certified through a CLI transport. The
//   certified lanes (deepseek/deepinfra/ollama) are API transports only.
// GAP: assert.ok(spawnCliArgs('codex').includes('--print-only')); // NOT TRUE TODAY — full-auto.
//   Closing GAP-1 requires spawning the CLI without self-execution and
//   pinning the argv in the 'full-auto basis' test above.

// GAP-2 (codex prompt staging write — outside the boundary):
//   codexCli.ts writes the prompt to a temp file with raw node:fs
//   (mkdtempSync / writeFileSync / unlinkSync / rmSync). That is a raw fs
//   write in the transport layer, outside the workspace transaction ledger —
//   but it is scoped to os.tmpdir() and its content is the prompt, never
//   model-directed, so it is not an effect the model can steer. The live guard
//   'codex prompt staging stays outside the workspace' keeps it tmpdir-scoped.
// GAP: assert.ok(noRawFsWritesIn('codexCli.ts')); // NOT TRUE TODAY — staging writes exist.

// GAP-3 (structuredRunner repair lane):
//   structuredRunner.ts instantiates GeminiApiRunner (and can wrap CLI
//   runners) for JSON repair. That is an additional API invocation outside the
//   certified provider lane. It remains API-call-only (no workspace effects),
//   so certification is unaffected; it must never grow a tool-execution path.
// GAP: assert.doesNotMatch(structuredRunnerSource, /executeTool/); // TRUE TODAY — keep it that way.

// GAP-4 (transport-inherent network surface):
//   API transports necessarily issue network calls to their configured
//   provider endpoint via global fetch or provider SDKs — the transport's
//   inherent surface, not a model-directed effect. The suite cannot
//   structurally prove fetch targets are provider-base-URL-only; the
//   enforceable claim is that model-directed network (curl, aws s3, scp)
//   flows through shell_exec and is intercepted by the boundary, which the
//   kernel probe above demonstrates ('curl -s https://example.com' denied).
// GAP: assert.ok(fetchTargetsOnlyProviderBaseUrls()); // NOT ENFORCEABLE TODAY — review required.
