import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const babelCliDir = join(repoRoot, 'babel-cli');
const pkgPath = join(babelCliDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

test('every npm script target reference exists on disk', () => {
  const missing = [];
  const scriptTargets = [];

  for (const [name, script] of Object.entries(pkg.scripts)) {
    const tokens = script.split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
      let token = tokens[i].replace(/^["']|["']$/g, '');
      if (i > 0 && (tokens[i - 1] === '--output' || tokens[i - 1] === '-o')) {
        continue;
      }
      if (token.startsWith('-File') && i + 1 < tokens.length) {
        token = tokens[i + 1].replace(/^["']|["']$/g, '');
      }
      if (
        token.endsWith('.ts') ||
        token.endsWith('.mjs') ||
        token.endsWith('.js') ||
        token.endsWith('.ps1') ||
        token.endsWith('.yaml') ||
        token.endsWith('.yml') ||
        token.endsWith('.json')
      ) {
        if (token.includes('=')) {
          token = token.split('=')[1].replace(/^["']|["']$/g, '');
        }
        if (
          token.startsWith('scripts/') ||
          token.startsWith('src/') ||
          token.startsWith('../tools/') ||
          token.startsWith('tools/') ||
          token.startsWith('promptfoo/') ||
          token.startsWith('bin/')
        ) {
          scriptTargets.push({ script: name, target: token });
        }
      }
    }
  }

  for (const { script, target } of scriptTargets) {
    let resolved;
    if (target.startsWith('../')) {
      resolved = resolve(repoRoot, target.slice(3));
    } else {
      resolved = resolve(babelCliDir, target);
    }

    if (target.includes('*')) {
      const matches = globSync(target, { cwd: babelCliDir });
      if (matches.length === 0) {
        missing.push({ script, target, resolved, reason: 'Glob matched 0 files' });
      }
    } else {
      if (!existsSync(resolved)) {
        missing.push({ script, target, resolved, reason: 'File does not exist' });
      }
    }
  }

  assert.equal(
    missing.length,
    0,
    `Found ${missing.length} missing npm script target(s):\n` +
      missing.map(m => `  [${m.script}] ${m.target} -> ${m.resolved} (${m.reason})`).join('\n')
  );
});

test('every discovered source test belongs to canonical unit lane or an explicit specialized lane', async () => {
  function findTests(dir) {
    let results = [];
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        results = results.concat(findTests(full));
      } else if (item.name.endsWith('.test.ts')) {
        const rel = relative(babelCliDir, full).split(sep).join('/');
        results.push(rel);
      }
    }
    return results.sort();
  }

  const allTests = findTests(join(babelCliDir, 'src'));
  assert.ok(allTests.length >= 741, `Expected at least 741 source test files, found ${allTests.length}`);

  // Load canonical unit shard inventory
  const { prepareUnitShard } = await import('../../babel-cli/scripts/run_ci_unit_shard.mjs');
  const unitShard = prepareUnitShard(babelCliDir, 0, 1);
  const unitInventory = new Set(unitShard.inventory);

  // Explicit, reviewed specialized lanes for non-shard suites:
  // - Acceptance suite: E2E and architectural acceptance scenarios (test:acceptance-v0)
  // - Daemon suite: Background service IPC and process lifecycle (test:daemon)
  // - Lab suite: Cross-model reference comparison and evaluation harness (test:claude-babel-lab)
  // - Interactive testing suite: TTY/REPL scenarios and live terminal tests (test:harness-runtime / test:daily-driver)
  const specializedLanes = {
    'acceptance-v0': [
      'src/acceptance/acceptance.test.ts',
      'src/acceptance/architecture.test.ts',
      'src/acceptance/hardening.test.ts',
    ],
    'daemon-integration': [
      'src/daemon/evidenceTruthfulness.test.ts',
      'src/daemon/integration.test.ts',
      'src/daemon/ipc.test.ts',
      'src/daemon/queue.test.ts',
      'src/daemon/recovery.test.ts',
    ],
    'claude-babel-astra-lab': [
      'src/claude-babel-astra-lab/claudeHarness.test.ts',
      'src/claude-babel-astra-lab/comparison-contract-v3.test.ts',
      'src/claude-babel-astra-lab/comparison-contract.test.ts',
      'src/claude-babel-astra-lab/comparison-runner.test.ts',
      'src/claude-babel-astra-lab/frozen-evaluator.test.ts',
      'src/claude-babel-astra-lab/lab.test.ts',
      'src/claude-babel-astra-lab/recovery-observation.test.ts',
    ],
    'interactive-harness-specialized': [
      'src/interactive/testing/chatDailyDriverCertification.test.ts',
      'src/interactive/testing/multiModelTelemetryAudit.test.ts',
      'src/interactive/testing/realCliInteractiveProcess.test.ts',
      'src/interactive/testing/simulatedTtyInteractive.test.ts',
      'src/interactive/projection/turnViewProjector.test.ts',
    ],
  };

  const specializedSet = new Set();
  for (const [lane, files] of Object.entries(specializedLanes)) {
    for (const file of files) {
      assert.ok(existsSync(join(babelCliDir, file)), `Specialized lane ${lane} references missing file: ${file}`);
      specializedSet.add(file);
    }
  }

  const unclassified = [];
  for (const testFile of allTests) {
    if (!unitInventory.has(testFile) && !specializedSet.has(testFile)) {
      unclassified.push(testFile);
    }
  }

  assert.equal(
    unclassified.length,
    0,
    `Found ${unclassified.length} unclassified source test file(s) outside both canonical unit inventory and specialized lanes:\n` +
      unclassified.map(f => `  ${f}`).join('\n')
  );
});
