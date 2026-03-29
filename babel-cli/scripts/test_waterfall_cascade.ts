/**
 * test_waterfall_cascade.ts — Waterfall Cascade + Subscription Smoke Tests
 *
 * Tests four areas in order of cost/risk:
 *
 *   Section 1 — Binary checks     : gemini / codex binaries present in PATH
 *   Section 2 — Runner unit tests : GeminiCliRunner with stub binaries
 *                                   (ENOENT, rate-limit, bad JSON, retry, model injection)
 *   Section 3 — Cascade chain     : runWithFallback with stub CLIs verifying
 *                                   tier-1-success, tier-1→tier-N cascade, all-fail
 *   Section 4 — Live subscription : real Gemini + Codex round-trips (opt-in --live)
 *
 * Usage:
 *   cd babel-cli
 *   npx tsx scripts/test_waterfall_cascade.ts           # Sections 1–3
 *   npx tsx scripts/test_waterfall_cascade.ts --live    # + Section 4
 *
 * Sections 1–3 make zero real API or subscription calls.
 * Section 4 calls the real CLI subscriptions — typically 10–30 seconds.
 */

import { execFileSync }                                              from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir }                                                   from 'node:os';
import { join }                                                     from 'node:path';
import { z }                                                        from 'zod';

import { GeminiCliRunner }                          from '../src/runners/geminiCli.js';
import { CodexCliRunner }                           from '../src/runners/codexCli.js';
import { StructuredRunner }                         from '../src/runners/structuredRunner.js';
import { CliParseError }                            from '../src/runners/cliBase.js';
import { runWithFallback }                          from '../src/execute.js';
import { EvidenceBundle }                           from '../src/evidence.js';
import {
  selectBestTierForStage,
  reorderWaterfallByStartIndex,
}                                                   from '../src/routingEngine.js';

// ─── Assertion + test harness ─────────────────────────────────────────────────

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

let passed = 0;
let failed = 0;

async function test(label: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  · ${label} ... `);
  try {
    await fn();
    console.log('PASS');
    passed++;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`FAIL\n    ${detail}`);
    failed++;
  }
}

// ─── Environment patch helper (same pattern as test_pipeline_v9.ts) ───────────

function withPatchedEnv(
  patch: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return run().finally(() => {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ─── Stub binary factory ──────────────────────────────────────────────────────
//
// Creates a temp dir with fake `gemini.cmd` and `codex.cmd` binaries.
// Returns an envPatch that prepends the dir to PATH so cmd.exe finds them.
//
// gemini behaviors:
//   'success'     — stdout: {"ok":true}
//   'bad-json'    — stdout: "this is not json"
//   'rate-limit'  — stderr: "rate limit exceeded", exit 1
//   'retry'       — bad JSON on first call, {"ok":true} on second (uses a flag file)
//   'echo-args'   — stdout: {"ok":true,"args":[...process.argv.slice(2)]}
//
// codex behavior:
//   'success'     — stdout: {"ok":true}
//   'bad-json'    — stdout: "this is not json"

type GeminiBehavior = 'success' | 'bad-json' | 'rate-limit' | 'retry' | 'echo-args';
type CodexBehavior  = 'success' | 'bad-json';

interface StubOptions {
  gemini: GeminiBehavior;
  codex?: CodexBehavior;
}

function createStubs(opts: StubOptions): { dir: string; envPatch: Record<string, string | undefined> } {
  const dir = mkdtempSync(join(tmpdir(), 'babel-cascade-'));

  // ── Gemini MJS ──────────────────────────────────────────────────────────────
  const geminiMjs = join(dir, 'fake-gemini.mjs');
  let gBody: string;

  switch (opts.gemini) {
    case 'success':
      gBody = `process.stdout.write(JSON.stringify({ ok: true }));\n`;
      break;
    case 'bad-json':
      gBody = `process.stdout.write('this is not json at all');\n`;
      break;
    case 'rate-limit':
      gBody = `process.stderr.write('rate limit exceeded: subscription quota hit');\nprocess.exit(1);\n`;
      break;
    case 'retry': {
      // Uses a flag file in the same dir to track call count
      const flagFile = join(dir, 'gemini-call.flag').replace(/\\/g, '\\\\');
      gBody = [
        `import { existsSync, writeFileSync } from 'node:fs';`,
        `const flag = ${JSON.stringify(flagFile)};`,
        `if (!existsSync(flag)) {`,
        `  writeFileSync(flag, '1');`,
        `  process.stdout.write('this is not json at all');`,
        `} else {`,
        `  process.stdout.write(JSON.stringify({ ok: true }));`,
        `}`,
        ``,
      ].join('\n');
      break;
    }
    case 'echo-args':
      // Outputs spawned CLI args (not the prompt — that comes via stdin)
      gBody = `const args = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ ok: true, args }));\n`;
      break;
    default:
      throw new Error(`Unknown gemini behavior: ${String(opts.gemini)}`);
  }

  writeFileSync(geminiMjs, gBody, 'utf-8');

  // Gemini uses stdin mode. The .cmd wrapper forwards all CLI args via %* so
  // the echo-args test can inspect which --model flag was injected.
  const geminiCmd = join(dir, 'gemini.cmd');
  writeFileSync(
    geminiCmd,
    `@echo off\r\nnode "${geminiMjs}" %*\r\n`,
    'utf-8',
  );

  // ── Codex MJS ───────────────────────────────────────────────────────────────
  const behavior = opts.codex ?? 'success';
  const codexMjs = join(dir, 'fake-codex.mjs');
  const cBody = behavior === 'success'
    ? `process.stdout.write(JSON.stringify({ ok: true }));\n`
    : `process.stdout.write('this is not json at all');\n`;
  writeFileSync(codexMjs, cBody, 'utf-8');

  // Codex uses positional prompt-file mode. The .cmd receives:
  //   codex exec --full-auto <promptFilePath>
  // Our stub ignores all args and just outputs the canned response.
  const codexCmd = join(dir, 'codex.cmd');
  writeFileSync(
    codexCmd,
    `@echo off\r\nnode "${codexMjs}"\r\n`,
    'utf-8',
  );

  return {
    dir,
    envPatch: {
      // Prepend stub dir to PATH so cmd.exe finds our fakes first.
      PATH: `${dir};${process.env['PATH'] ?? ''}`,
      // Disable all repair-loop API runners so CliParseErrors surface cleanly.
      GEMINI_API_KEY:   undefined,
      ANTHROPIC_API_KEY: undefined,
    },
  };
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const okSchema   = z.object({ ok: z.literal(true) });
const argsSchema = z.object({ ok: z.literal(true), args: z.array(z.string()) });

const SIMPLE_PROMPT = 'Output exactly this JSON: {"ok":true}';

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — Binary health checks
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n─── Section 1: Binary health checks ───────────────────────────');

await test('gemini binary is in PATH and responds to --version', async () => {
  const out = execFileSync('cmd.exe', ['/c', 'gemini', '--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  assert(out.trim().length > 0, `gemini --version produced empty output`);
});

await test('codex binary is in PATH and responds to --version', async () => {
  const out = execFileSync('cmd.exe', ['/c', 'codex', '--version'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  assert(out.trim().length > 0, `codex --version produced empty output`);
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — GeminiCliRunner unit tests (stub binary)
// ═════════════════════════════════════════════════════════════════════════════
//
//  Each test verifies what ERROR TYPE is thrown, because that's the signal
//  runWaterfall uses to decide between immediate cascade vs. retry:
//
//    plain Error (not CliParseError)  → immediate cascade (ENOENT, rate-limit)
//    CliParseError                    → retry up to maxCliAttempts, then cascade

console.log('\n─── Section 2: GeminiCliRunner unit tests (stub binary) ────────');

await test('ENOENT → plain Error, not CliParseError (immediate cascade signal)', async () => {
  await withPatchedEnv({ BABEL_GEMINI_CMD: 'nonexistent-binary-xyz-888' }, async () => {
    const runner = new GeminiCliRunner();
    try {
      await runner.execute(SIMPLE_PROMPT, okSchema);
      throw new Error('Expected runner to throw');
    } catch (err) {
      assert(!(err instanceof CliParseError), 'ENOENT must be a plain Error, not CliParseError');
      assert(err instanceof Error, 'Expected an Error instance');
      // On Windows, cmd.exe /c <missing-binary> exits with code 1 and prints
      // "not recognized as an internal or external command" to stderr.
      // On POSIX, Node raises ENOENT directly. Both are plain Errors (not
      // CliParseError) and both trigger isImmediateCascade in the waterfall.
      const msg = err.message.toLowerCase();
      assert(
        msg.includes('not found') || msg.includes('enoent') || msg.includes('not recognized'),
        `Expected binary-missing signal in message. Got: ${err.message}`,
      );
    }
  });
});

await test('Rate-limit in stderr → plain Error with "rate limit:" prefix (immediate cascade)', async () => {
  const { envPatch } = createStubs({ gemini: 'rate-limit' });
  await withPatchedEnv(envPatch, async () => {
    const runner = new GeminiCliRunner();
    try {
      await runner.execute(SIMPLE_PROMPT, okSchema);
      throw new Error('Expected runner to throw');
    } catch (err) {
      assert(!(err instanceof CliParseError), 'Rate-limit must be plain Error, not CliParseError');
      assert(err instanceof Error, 'Expected an Error instance');
      assert(
        err.message.toLowerCase().startsWith('rate limit'),
        `Expected "rate limit" prefix. Got: ${err.message}`,
      );
    }
  });
});

await test('Bad JSON output → CliParseError (retry signal for waterfall)', async () => {
  const { envPatch } = createStubs({ gemini: 'bad-json' });
  await withPatchedEnv(envPatch, async () => {
    const runner = new GeminiCliRunner();
    try {
      await runner.execute(SIMPLE_PROMPT, okSchema);
      throw new Error('Expected runner to throw');
    } catch (err) {
      assert(
        err instanceof CliParseError,
        `Expected CliParseError. Got: ${err instanceof Error ? err.constructor.name + ': ' + err.message : String(err)}`,
      );
    }
  });
});

await test('Valid JSON output → returns parsed result (no throw)', async () => {
  const { envPatch } = createStubs({ gemini: 'success' });
  await withPatchedEnv(envPatch, async () => {
    const runner = new GeminiCliRunner();
    const result = await runner.execute(SIMPLE_PROMPT, okSchema);
    assert(result.ok === true, `Expected { ok: true }, got ${JSON.stringify(result)}`);
  });
});

await test('Retry: bad JSON on attempt 1, valid JSON on attempt 2 → succeeds', async () => {
  // Uses runWithFallback (stage: executor) so the waterfall retry loop fires.
  // DEEPINFRA_API_KEY is cleared → API tiers cascade immediately (factory throws).
  const { envPatch } = createStubs({ gemini: 'retry' });
  await withPatchedEnv({ ...envPatch, DEEPINFRA_API_KEY: undefined }, async () => {
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, {
      stage:          'executor',
      maxCliAttempts: 2,
    });
    assert(result.ok === true, `Expected { ok: true }, got ${JSON.stringify(result)}`);
  });
});

await test('Model ID is injected as --model arg into spawn args', async () => {
  const { envPatch } = createStubs({ gemini: 'echo-args' });
  await withPatchedEnv(envPatch, async () => {
    const model  = 'gemini-3.1-flash-lite-preview';
    const runner = new GeminiCliRunner(model);
    const result = await runner.execute(SIMPLE_PROMPT, argsSchema);
    const idx    = result.args.indexOf('--model');
    assert(idx !== -1, `--model flag not found in spawned args: ${JSON.stringify(result.args)}`);
    assert(
      result.args[idx + 1] === model,
      `Expected model "${model}", got "${result.args[idx + 1] ?? '(missing)'}"`,
    );
  });
});

await test('Model stripped from BABEL_GEMINI_ARGS to avoid duplicate --model', async () => {
  // When the constructor model conflicts with BABEL_GEMINI_ARGS --model, only
  // the constructor model should appear in the args — not both.
  const { envPatch } = createStubs({ gemini: 'echo-args' });
  await withPatchedEnv(
    { ...envPatch, BABEL_GEMINI_ARGS: '--model gemini-2.5-pro' },
    async () => {
      const constructorModel = 'gemini-3.1-flash-lite-preview';
      const runner = new GeminiCliRunner(constructorModel);
      const result = await runner.execute(SIMPLE_PROMPT, argsSchema);

      const modelArgs = result.args.filter(a => a === '--model' || a.startsWith('--model='));
      assert(
        modelArgs.length === 1,
        `Expected exactly one --model flag, got ${modelArgs.length}: ${JSON.stringify(result.args)}`,
      );
      const idx = result.args.indexOf('--model');
      assert(
        result.args[idx + 1] === constructorModel,
        `Expected constructor model "${constructorModel}", got "${result.args[idx + 1] ?? '(missing)'}"`,
      );
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — Waterfall cascade integration via runWithFallback
// ═════════════════════════════════════════════════════════════════════════════
//
//  ORCHESTRATOR waterfall: Gemini CLI → Nemotron API → Codex CLI
//
//  Cascade trigger strategy (zero network calls):
//    - API tier cascade: clear DEEPINFRA_API_KEY → factory throws → immediate cascade
//    - CLI ENOENT: set BABEL_GEMINI_CMD to a nonexistent binary name
//    - CLI rate-limit: fake gemini.cmd emits "rate limit exceeded" to stderr

console.log('\n─── Section 3: Waterfall cascade integration ────────────────────');

await test('Tier 1 success: Gemini stub succeeds → returns at tier 1, no cascade', async () => {
  const { envPatch } = createStubs({ gemini: 'success' });
  await withPatchedEnv(envPatch, async () => {
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, { stage: 'orchestrator' });
    assert(result.ok === true, `Expected { ok: true }, got ${JSON.stringify(result)}`);
  });
});

await test('ENOENT cascade: Gemini not found → API cascades (no key) → Codex stub succeeds', async () => {
  // Stubs dir has a working codex.cmd. We override BABEL_GEMINI_CMD to a
  // nonexistent binary, so Gemini ENOENT → API factory throws → Codex runs.
  const { envPatch } = createStubs({ gemini: 'success', codex: 'success' });
  await withPatchedEnv({
    ...envPatch,
    BABEL_GEMINI_CMD:  'nonexistent-gemini-cascade-test',
    DEEPINFRA_API_KEY: undefined,
  }, async () => {
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, {
      stage:          'orchestrator',
      maxCliAttempts: 1,
    });
    assert(result.ok === true, `Expected { ok: true } from Codex after cascade`);
  });
});

await test('Rate-limit cascade: Gemini rate-limits → API cascades (no key) → Codex stub succeeds', async () => {
  const { envPatch } = createStubs({ gemini: 'rate-limit', codex: 'success' });
  await withPatchedEnv({ ...envPatch, DEEPINFRA_API_KEY: undefined }, async () => {
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, {
      stage:          'orchestrator',
      maxCliAttempts: 1,
    });
    assert(result.ok === true, `Expected { ok: true } from Codex after rate-limit cascade`);
  });
});

await test('Bad-JSON cascade: Gemini bad JSON (×maxAttempts) → API cascades → Codex stub succeeds', async () => {
  const { envPatch } = createStubs({ gemini: 'bad-json', codex: 'success' });
  await withPatchedEnv({ ...envPatch, DEEPINFRA_API_KEY: undefined }, async () => {
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, {
      stage:          'orchestrator',
      maxCliAttempts: 2, // Gemini gets 2 attempts before cascading
    });
    assert(result.ok === true, `Expected { ok: true } from Codex after bad-JSON cascade`);
  });
});

await test('All tiers fail → throws "All N runners failed" error', async () => {
  // Executor waterfall: Gemini (ENOENT) → Qwen3 API (no key) → Nemotron API (no key)
  const { envPatch } = createStubs({ gemini: 'bad-json' });
  await withPatchedEnv({
    ...envPatch,
    BABEL_GEMINI_CMD:  'nonexistent-gemini-allfail-test',
    DEEPINFRA_API_KEY: undefined,
  }, async () => {
    try {
      await runWithFallback(SIMPLE_PROMPT, okSchema, {
        stage:          'executor',
        maxCliAttempts: 1,
      });
      throw new Error('Expected waterfall to exhaust and throw, but it returned successfully');
    } catch (err) {
      assert(err instanceof Error, 'Expected an Error instance');
      assert(
        err.message.toLowerCase().includes('all') && err.message.toLowerCase().includes('runner'),
        `Expected "All N runners failed" message. Got: ${err.message}`,
      );
    }
  });
});

await test('Legacy mode "structural" routes to orchestrator waterfall (Gemini tier 1)', async () => {
  const { envPatch } = createStubs({ gemini: 'success' });
  await withPatchedEnv(envPatch, async () => {
    // @ts-expect-error — testing deprecated mode field
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, { mode: 'structural' });
    assert(result.ok === true, `Legacy mode "structural" should hit Gemini at tier 1`);
  });
});

await test('Legacy mode "reasoning" routes to planning waterfall (Codex tier 1)', async () => {
  // Planning waterfall starts with Codex. Gemini is only tier 3+.
  // With a bad gemini stub and working codex stub, "reasoning" should reach Codex.
  // We force Codex to be the stub by prepending its dir to PATH; Gemini cmd is
  // not reached (it's tier 3 in planning, behind the API tiers which cascade on no key).
  const { envPatch } = createStubs({ gemini: 'bad-json', codex: 'success' });
  await withPatchedEnv({ ...envPatch, DEEPINFRA_API_KEY: undefined }, async () => {
    // @ts-expect-error — testing deprecated mode field
    const result = await runWithFallback(SIMPLE_PROMPT, okSchema, { mode: 'reasoning', maxCliAttempts: 1 });
    // Codex is tier 1 in planning — it should succeed from the stub
    assert(result.ok === true, `Legacy mode "reasoning" should route to Codex at tier 1`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — Live subscription + API cascade tests (opt-in: --live)
// ═════════════════════════════════════════════════════════════════════════════
//
//  4a (CLI)  — real Gemini and Codex subscription round-trips.
//  4b (API)  — real DeepInfra Nemotron API round-trip and cascade.
//              Requires DEEPINFRA_API_KEY to be set. Skipped if absent.
//
//  Both sections use StructuredRunner so sentinel prompting is active (same
//  path as the real pipeline waterfalls).

const RUN_LIVE     = process.argv.includes('--live');
const HAS_DEEPINFRA = Boolean(process.env['DEEPINFRA_API_KEY']);

if (RUN_LIVE) {
  console.log('\n─── Section 4a: Live CLI subscription smoke tests ───────────────');

  const LIVE_PROMPT = [
    'Output ONLY the following JSON object — no explanation, no prose, no markdown fences:',
    '{"ok":true}',
  ].join('\n');

  await test('Gemini CLI: real subscription round-trip (StructuredRunner)', async () => {
    // Uses executor waterfall so Gemini Flash-Lite is tier 1.
    const result = await runWithFallback(LIVE_PROMPT, okSchema, {
      stage:          'executor',
      maxCliAttempts: 1,
    });
    assert(result.ok === true, `Expected { ok: true }, got ${JSON.stringify(result)}`);
  });

  await test('Codex CLI: real subscription round-trip (StructuredRunner)', async () => {
    // Tests Codex directly via StructuredRunner (avoids cascade through
    // Gemini + API tiers).
    const runner = new StructuredRunner(new CodexCliRunner(), 'Codex CLI');
    const result = await runner.execute(LIVE_PROMPT, okSchema);
    assert(result.ok === true, `Expected { ok: true }, got ${JSON.stringify(result)}`);
  });

  await test('Gemini → Codex subscription cascade: Gemini ENOENT → Codex succeeds', async () => {
    // End-to-end subscription cascade: real Codex handles the full
    // StructuredRunner sentinel prompt and returns parseable JSON.
    await withPatchedEnv({
      BABEL_GEMINI_CMD:  'nonexistent-gemini-live-cascade',
      DEEPINFRA_API_KEY: undefined,
    }, async () => {
      const result = await runWithFallback(LIVE_PROMPT, okSchema, {
        stage:          'orchestrator',
        maxCliAttempts: 1,
      });
      assert(result.ok === true, `Expected { ok: true } from real Codex after Gemini cascade`);
    });
  });

  // ── Section 4b: DeepInfra API cascade tests ─────────────────────────────

  if (HAS_DEEPINFRA) {
    console.log('\n─── Section 4b: Live DeepInfra API cascade tests ────────────────');

    await test('Nemotron 3 Super API: direct round-trip', async () => {
      // Calls Nemotron directly, bypassing CLI tiers, by forcing Gemini ENOENT
      // so the QA waterfall (Nemotron is tier 1) is hit directly.
      // QA waterfall: Nemotron → Gemini-MID → Codex
      const result = await runWithFallback(LIVE_PROMPT, okSchema, {
        stage:          'qa',
        maxCliAttempts: 1,
      });
      assert(result.ok === true, `Expected { ok: true } from Nemotron, got ${JSON.stringify(result)}`);
    });

    await test('Gemini ENOENT → Nemotron API cascade (orchestrator tier 1→2)', async () => {
      // Forces Gemini to ENOENT so the cascade fires into the real Nemotron
      // API tier. This is the most common real-world cascade scenario.
      await withPatchedEnv({ BABEL_GEMINI_CMD: 'nonexistent-gemini-api-cascade' }, async () => {
        const result = await runWithFallback(LIVE_PROMPT, okSchema, {
          stage:          'orchestrator',
          maxCliAttempts: 1,
        });
        assert(result.ok === true, `Expected { ok: true } from Nemotron after Gemini cascade`);
      });
    });

    await test('Gemini bad JSON → Nemotron repair cascade (orchestrator tier 1→2)', async () => {
      // Fake Gemini emits bad JSON for maxCliAttempts rounds, then Nemotron
      // API picks up. Tests the parse-failure cascade path end-to-end.
      const { envPatch } = createStubs({ gemini: 'bad-json' });
      await withPatchedEnv(envPatch, async () => {
        const result = await runWithFallback(LIVE_PROMPT, okSchema, {
          stage:          'orchestrator',
          maxCliAttempts: 2,
        });
        assert(result.ok === true, `Expected { ok: true } from Nemotron after parse cascade`);
      });
    });

    await test('Qwen3-32B API: direct round-trip (executor tier 2)', async () => {
      // Executor waterfall: Gemini (ENOENT) → Qwen3 (tier 2, real API).
      await withPatchedEnv({ BABEL_GEMINI_CMD: 'nonexistent-gemini-qwen3-test' }, async () => {
        const result = await runWithFallback(LIVE_PROMPT, okSchema, {
          stage:          'executor',
          maxCliAttempts: 1,
        });
        assert(result.ok === true, `Expected { ok: true } from Qwen3, got ${JSON.stringify(result)}`);
      });
    });

  } else {
    console.log('\n─── Section 4b: DeepInfra API tests (skipped — DEEPINFRA_API_KEY not set) ─');
  }

} else {
  console.log('\n─── Section 4: Live tests (skipped — run with --live to enable) ─');
}

// ─── Section 5 — Dynamic Routing v1.1 ────────────────────────────────────────
//
// Tests the routing engine and the canonical tier_index preservation fix
// without any live API or subscription calls.
//
// Critical property: after dynamic routing reorders the waterfall, the
// tier_index recorded in telemetry must be the CANONICAL slot (original
// position in the stage's static waterfall definition), not the runtime
// position in the reordered array.

console.log('\n─── Section 5: Dynamic Routing v1.1 ─────────────────────────────────────────');

// ── Helper: build a fake runs directory with one telemetry file ──────────────

function makeFakeRunsDir(entries: object[]): { runsDir: string } {
  const runsDir = mkdtempSync(join(tmpdir(), 'babel-routing-runs-'));
  const runDir  = join(runsDir, '20260101_000000_test-run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '05_waterfall_telemetry.json'),
    JSON.stringify(entries),
    'utf-8',
  );
  return { runsDir };
}

// ── Unit tests — selectBestTierForStage ──────────────────────────────────────

await test('5.1 routing disabled by default returns null', async () => {
  await withPatchedEnv({ BABEL_DYNAMIC_ROUTING: undefined }, async () => {
    const decision = selectBestTierForStage('orchestrator', ['A', 'B', 'C'], {
      runsDir: '/nonexistent',
    });
    assert(decision === null, 'Expected null when BABEL_DYNAMIC_ROUTING is unset');
  });
});

await test('5.2 dynamicRouting:false overrides BABEL_DYNAMIC_ROUTING=true', async () => {
  const { runsDir } = makeFakeRunsDir([
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
  ]);
  await withPatchedEnv({ BABEL_DYNAMIC_ROUTING: 'true' }, async () => {
    const decision = selectBestTierForStage('orchestrator', ['A', 'B', 'C'], {
      enabled: false, runsDir,
    });
    assert(decision === null, 'Expected null when enabled:false overrides env true');
  });
});

await test('5.3 thin telemetry (below MIN_SAMPLES) returns null', async () => {
  const { runsDir } = makeFakeRunsDir([
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
  ]);
  await withPatchedEnv({ BABEL_DYNAMIC_ROUTING: 'true', BABEL_DYNAMIC_ROUTING_MIN_SAMPLES: '5' }, async () => {
    const decision = selectBestTierForStage('orchestrator', ['A', 'B', 'C'], { runsDir });
    assert(decision === null, 'Expected null for 1 entry when MIN_SAMPLES=5');
  });
});

await test('5.4 single-tier waterfall returns null', async () => {
  const { runsDir } = makeFakeRunsDir([
    { stage: 'orchestrator', tier_succeeded: 'A', tier_index: 0, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
    { stage: 'orchestrator', tier_succeeded: 'A', tier_index: 0, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
    { stage: 'orchestrator', tier_succeeded: 'A', tier_index: 0, attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: '' },
  ]);
  await withPatchedEnv({ BABEL_DYNAMIC_ROUTING: 'true' }, async () => {
    const decision = selectBestTierForStage('orchestrator', ['A'], { enabled: true, runsDir });
    assert(decision === null, 'Expected null for single-tier waterfall');
  });
});

await test('5.5 selects best tier from telemetry history', async () => {
  // Tier B wins 3/3 — A is skipped every time. B should score highest.
  const { runsDir } = makeFakeRunsDir([
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: ['A'], cascade_reason: 'enoent', ts: '' },
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: ['A'], cascade_reason: 'enoent', ts: '' },
    { stage: 'orchestrator', tier_succeeded: 'B', tier_index: 1, attempts: 1, tiers_skipped: ['A'], cascade_reason: 'enoent', ts: '' },
  ]);
  await withPatchedEnv({ BABEL_DYNAMIC_ROUTING: 'true' }, async () => {
    const decision = selectBestTierForStage('orchestrator', ['A', 'B', 'C'], { runsDir });
    assert(decision !== null,           'Expected a routing decision');
    assert(decision.selectedName  === 'B', `Expected B to win, got "${decision.selectedName}"`);
    assert(decision.selectedIndex === 1,   `Expected selectedIndex=1, got ${decision.selectedIndex}`);
  });
});

// ── Unit tests — reorderWaterfallByStartIndex ────────────────────────────────

await test('5.6 reorder: startIndex=0 returns unchanged', async () => {
  const result = reorderWaterfallByStartIndex(['A', 'B', 'C'], 0);
  assert(result[0] === 'A' && result[1] === 'B' && result[2] === 'C',
    `Expected [A,B,C], got ${JSON.stringify(result)}`);
});

await test('5.7 reorder: startIndex=undefined returns unchanged', async () => {
  const result = reorderWaterfallByStartIndex(['A', 'B', 'C'], undefined);
  assert(result[0] === 'A', `Expected A at [0], got ${result[0]}`);
});

await test('5.8 reorder: startIndex=1 moves B to front', async () => {
  const result = reorderWaterfallByStartIndex(['A', 'B', 'C'], 1);
  assert(result[0] === 'B', `Expected B at [0], got ${result[0]}`);
  assert(result[1] === 'A', `Expected A at [1], got ${result[1]}`);
  assert(result[2] === 'C', `Expected C at [2], got ${result[2]}`);
});

await test('5.9 reorder: startIndex=2 moves C to front', async () => {
  const result = reorderWaterfallByStartIndex(['A', 'B', 'C'], 2);
  assert(result[0] === 'C', `Expected C at [0], got ${result[0]}`);
  assert(result[1] === 'A', `Expected A at [1], got ${result[1]}`);
  assert(result[2] === 'B', `Expected B at [2], got ${result[2]}`);
});

// ── Integration test — canonical tier_index after reorder ────────────────────
//
// Scenario:
//   ORCHESTRATOR_WATERFALL = [Gemini(0), Nemotron(1), Codex(2)]
//   Fake telemetry: Codex CLI wins 5× → routing selects index 2
//   Reordered runtime: [Codex(→0), Gemini(→1), Nemotron(→2)]
//   Codex stub succeeds at runtime position 0
//   Expected: tier_index=2 (canonical), tier_succeeded='Codex CLI', tiers_skipped=[]
//
// Without the originalIndex fix: tier_index would be 0 (runtime slot) — wrong.
// With the fix: tier_index is 2 (canonical slot) — correct.

await test('5.10 tier_index preserves canonical slot after dynamic reorder', async () => {
  const codexName = 'Codex CLI';

  // Five wins for Codex at its canonical position (index 2 in orchestrator).
  const { runsDir } = makeFakeRunsDir(
    Array.from({ length: 5 }, (_, i) => ({
      stage:          'orchestrator',
      tier_succeeded: codexName,
      tier_index:     2,
      attempts:       1,
      tiers_skipped:  ['Gemini CLI (gemini-3.1-flash-lite-preview)', 'Nemotron 3 Super'],
      cascade_reason: 'enoent',
      ts:             new Date(Date.now() - i * 1000).toISOString(),
    })),
  );

  const { dir: stubDir, envPatch } = createStubs({ gemini: 'success', codex: 'success' });
  const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-routing-evidence-'));

  const okSchema = z.object({ ok: z.literal(true) });
  const evidence = new EvidenceBundle('routing-tier-index-test', evidenceDir);

  try {
    await withPatchedEnv(
      { ...envPatch, BABEL_RUNS_DIR: runsDir, BABEL_DYNAMIC_ROUTING: undefined },
      async () => {
        await runWithFallback('emit {"ok":true}', okSchema, {
          stage:          'orchestrator',
          maxCliAttempts: 1,
          dynamicRouting: true,
          evidence,
        });
      },
    );
  } finally {
    try { unlinkSync(join(stubDir, 'gemini.cmd')); } catch { /* ignore */ }
    try { unlinkSync(join(stubDir, 'codex.cmd'));  } catch { /* ignore */ }
  }

  // Flush and read telemetry.
  evidence.writeWaterfallTelemetry();
  const telemetryPath = join(evidence.runDir, '05_waterfall_telemetry.json');
  assert(existsSync(telemetryPath), `Telemetry file not written: ${telemetryPath}`);

  const entries = JSON.parse(readFileSync(telemetryPath, 'utf-8')) as Array<{
    tier_succeeded: string;
    tier_index:     number;
    tiers_skipped:  string[];
  }>;
  assert(entries.length === 1, `Expected 1 telemetry entry, got ${entries.length}`);

  const entry = entries[0]!;
  assert(
    entry.tier_succeeded === codexName,
    `Routing should have selected Codex. Got: "${entry.tier_succeeded}". ` +
    `(If Gemini won, dynamic routing did not activate.)`,
  );
  assert(
    entry.tier_index === 2,
    `tier_index should be CANONICAL slot 2, got ${entry.tier_index}. ` +
    `(Value 0 means the runtime position was recorded — originalIndex stamping is broken.)`,
  );
  assert(
    entry.tiers_skipped.length === 0,
    `tiers_skipped should be empty (Codex ran first via routing), got: ${JSON.stringify(entry.tiers_skipped)}`,
  );
});

// ─── Section 6 — Confidence Gate unit tests ───────────────────────────────────
//
//  All tests in this section are pure unit tests against the confidenceGate.ts
//  helpers. Zero real LLM calls are made.
//
//  Test 6.1  — getRoutingConfidenceBand: high band
//  Test 6.2  — getRoutingConfidenceBand: medium band (lower edge)
//  Test 6.3  — getRoutingConfidenceBand: medium band (upper edge)
//  Test 6.4  — getRoutingConfidenceBand: low band
//  Test 6.5  — getRoutingConfidenceBand: exactly at HIGH_THRESHOLD is high
//  Test 6.6  — getRoutingConfidenceBand: exactly at MED_THRESHOLD is medium
//  Test 6.7  — Custom thresholds via env overrides
//  Test 6.8  — isConfidenceGateEnabled: off by default
//  Test 6.9  — isConfidenceGateEnabled: on when env set
//  Test 6.10 — getValidatorTierIndex: default is 1; env override respected
// ─────────────────────────────────────────────────────────────────────────────

import {
  getRoutingConfidenceBand,
  getHighThreshold,
  getMediumThreshold,
  getValidatorTierIndex,
  isConfidenceGateEnabled,
} from '../src/confidenceGate.js';

console.log('');
console.log('Section 6 — Confidence Gate unit tests');

await test('6.1 band: 1.0 → high', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_HIGH: undefined, BABEL_ROUTING_CONFIDENCE_MEDIUM: undefined }, async () => {
    assert(getRoutingConfidenceBand(1.0) === 'high', `Expected high, got ${getRoutingConfidenceBand(1.0)}`);
  });
});

await test('6.2 band: 0.65 → medium', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_HIGH: undefined, BABEL_ROUTING_CONFIDENCE_MEDIUM: undefined }, async () => {
    const band = getRoutingConfidenceBand(0.65);
    assert(band === 'medium', `Expected medium, got ${band}`);
  });
});

await test('6.3 band: 0.79 → medium (just below high threshold)', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_HIGH: undefined, BABEL_ROUTING_CONFIDENCE_MEDIUM: undefined }, async () => {
    const band = getRoutingConfidenceBand(0.79);
    assert(band === 'medium', `Expected medium, got ${band}`);
  });
});

await test('6.4 band: 0.30 → low', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_HIGH: undefined, BABEL_ROUTING_CONFIDENCE_MEDIUM: undefined }, async () => {
    const band = getRoutingConfidenceBand(0.30);
    assert(band === 'low', `Expected low, got ${band}`);
  });
});

await test('6.5 band: exactly 0.80 → high (boundary is inclusive)', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_HIGH: undefined, BABEL_ROUTING_CONFIDENCE_MEDIUM: undefined }, async () => {
    const band = getRoutingConfidenceBand(0.80);
    assert(band === 'high', `Expected high at exact threshold, got ${band}`);
  });
});

await test('6.6 band: exactly 0.60 → medium (MED boundary is inclusive)', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_HIGH: undefined, BABEL_ROUTING_CONFIDENCE_MEDIUM: undefined }, async () => {
    const band = getRoutingConfidenceBand(0.60);
    assert(band === 'medium', `Expected medium at exact MED threshold, got ${band}`);
  });
});

await test('6.7 custom thresholds via env override', async () => {
  await withPatchedEnv(
    { BABEL_ROUTING_CONFIDENCE_HIGH: '0.90', BABEL_ROUTING_CONFIDENCE_MEDIUM: '0.70' },
    async () => {
      assert(getHighThreshold()   === 0.90, `Expected HIGH=0.90, got ${getHighThreshold()}`);
      assert(getMediumThreshold() === 0.70, `Expected MED=0.70,  got ${getMediumThreshold()}`);
      // With custom thresholds: 0.85 is medium (below 0.90 high)
      assert(getRoutingConfidenceBand(0.85) === 'medium', `Expected medium with custom thresholds`);
      // 0.60 is now low (below 0.70 medium)
      assert(getRoutingConfidenceBand(0.60) === 'low', `Expected low with custom MED=0.70`);
    },
  );
});

await test('6.8 isConfidenceGateEnabled: off by default', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_ENABLE: undefined }, async () => {
    assert(!isConfidenceGateEnabled(), 'Gate should be disabled when env var is not set');
  });
});

await test('6.9 isConfidenceGateEnabled: on when env=true', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_ENABLE: 'true' }, async () => {
    assert(isConfidenceGateEnabled(), 'Gate should be enabled when BABEL_ROUTING_CONFIDENCE_ENABLE=true');
  });
});

await test('6.10 getValidatorTierIndex: default=1; env override respected', async () => {
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_VALIDATOR_TIER_INDEX: undefined }, async () => {
    assert(getValidatorTierIndex() === 1, `Default tier index should be 1, got ${getValidatorTierIndex()}`);
  });
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_VALIDATOR_TIER_INDEX: '2' }, async () => {
    assert(getValidatorTierIndex() === 2, `Override to 2 failed, got ${getValidatorTierIndex()}`);
  });
  // Invalid value should fall back to 1
  await withPatchedEnv({ BABEL_ROUTING_CONFIDENCE_VALIDATOR_TIER_INDEX: 'bad' }, async () => {
    assert(getValidatorTierIndex() === 1, `Bad value should fall back to 1, got ${getValidatorTierIndex()}`);
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
