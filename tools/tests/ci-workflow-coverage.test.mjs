import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { commandCoverage, parseWorkflow } from '../ci-workflow-coverage.mjs';

const workflow = parseWorkflow(readFileSync(new URL('../../.github/workflows/typecheck.yml', import.meta.url), 'utf8'));
const command = 'npm run test:harness-acceptance';
test('desktop has independent discovery and a blocking command on both platforms', () => {
  assert.deepEqual(commandCoverage(workflow, 'npm run test'), {
    'ubuntu-latest': ['desktop-tests'], 'windows-latest': ['desktop-tests'],
  });
  const job = workflow.jobs['desktop-tests'];
  assert.ok(job.steps.some(s => s.run === 'node tools/check-desktop-test-inventory.mjs'));
  assert.equal(job.steps.find(s => s.run === 'npm run test')['working-directory'], 'babel-desktop');
});
test('missing desktop discovery fails independently of the CLI inventory', async () => {
  const { checkDesktopInventory } = await import('../check-desktop-test-inventory.mjs');
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-inventory-'));
  try {
    mkdirSync(join(root, 'test'));
    for (const name of ['bundle', 'core', 'diagnostics', 'installed-runtime', 'native', 'package-windows-setup']) writeFileSync(join(root, 'test', name + '.test.mjs'), 'fixture');
    writeFileSync(join(root, 'package.json'), JSON.stringify({scripts:{test:'node scripts/build.mjs && node --test test/*.test.mjs'}}));
    const url = new URL('file:///' + root.replaceAll('\\', '/') + '/');
    assert.equal(checkDesktopInventory(url).files.length, 6);
    rmSync(join(root, 'test/package-windows-setup.test.mjs'));
    assert.throws(() => checkDesktopInventory(url), /Desktop regression missing/);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
test('unique integrity and event-aware metadata fixtures block both aggregate gates', () => {
  for (const gate of ['linux-validation', 'windows-portability']) {
    assert.ok(workflow.jobs[gate].needs.includes('policy-integrity'));
    assert.ok(workflow.jobs[gate].needs.includes('public-pr-metadata-tests'));
  }
  const job = workflow.jobs['public-pr-metadata-tests'];
  assert.equal(job.if, undefined);
  assert.equal(job.steps.find(s => s.run?.includes('test-public-pr-metadata.ps1')).if, "github.event_name == 'pull_request'");
  assert.ok(job.steps.some(s => s.if === "github.event_name != 'pull_request'" && /not applicable/.test(s.run)));
});
test('matrix commands establish required Linux and Windows dependency coverage', () => {
  assert.deepEqual(commandCoverage(workflow, command), {
    'ubuntu-latest': ['platform-core'], 'windows-latest': ['platform-core'],
  });
});
for (const [label, change] of [
  ['missing Windows', w => { w.jobs['platform-core'].strategy.matrix.os = ['ubuntu-latest']; }],
  ['excluded Windows', w => { w.jobs['platform-core'].strategy.matrix.exclude = [{ os: 'windows-latest' }]; }],
  ['conditional provider', w => { w.jobs['platform-core'].if = 'false'; }],
  ['conditional command', w => { w.jobs['platform-core'].steps.find(s => s.run?.includes(command)).if = 'false'; }],
  ['tolerated command failure', w => { w.jobs['platform-core'].steps.find(s => s.run?.includes(command))['continue-on-error'] = true; }],
  ['missing Windows gate dependency', w => { w.jobs['windows-portability'].needs = w.jobs['windows-portability'].needs.filter(n => n !== 'platform-core'); }],
  ['missing command', w => { w.jobs['platform-core'].steps = w.jobs['platform-core'].steps.filter(s => !s.run?.includes(command)); }],
  ['comment-only command', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `# ${command}`; }],
  ['quoted command data', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `Write-Output '${command}'`; }],
  ['unreachable command', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `if ($false) {\n  ${command}\n}`; }],
  ['different script with shared prefix', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `${command}-different`; }],
  ['early exit before command', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `exit $LASTEXITCODE\n${command}`; }],
  ['later success masks command failure', w => { w.jobs['platform-core'].steps.find(s => s.run === command).run = `${command}\nnpm run typecheck`; }],
  ['custom shell only prints the script', w => { w.jobs['platform-core'].steps.find(s => s.run === command).shell = 'pwsh -NoProfile -Command "Get-Content {0}"'; }],
  ['skippable aggregate', w => { delete w.jobs['windows-portability'].if; }],
  ['missing dependency guard', w => { w.jobs['linux-validation'].steps = []; }],
]) {
  test(`${label} fails closed`, () => {
    const changed = structuredClone(workflow);
    change(changed);
    assert.throws(() => commandCoverage(changed, command));
  });
}

// Consumer packaging must be an unconditional dependency of both protected gates.
test('consumer artifact install is required on Linux and Windows', () => {
  assert.deepEqual(commandCoverage(workflow, 'npm run test:consumer-artifact'), {
    'ubuntu-latest': ['consumer-artifact'], 'windows-latest': ['consumer-artifact'],
  });
});

test('consumer guard blocks direct and normalized socket arguments without contacting a server', () => {
  const guard = new URL('../../babel-cli/scripts/block_consumer_network.mjs', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    let allowed = 0;
    net.Socket.prototype.connect = function() { allowed++; return this; };
    await import(${JSON.stringify(guard)});
    assert.throws(() => net.createConnection({host:'external.invalid',port:443}), /blocked/);
    assert.throws(() => new net.Socket().connect(443,'external.invalid'), /blocked/);
    assert.throws(() => new net.Socket().connect([{host:'external.invalid',port:443},null]), /blocked/);
    assert.equal(allowed, 0);
    net.createConnection({host:'127.0.0.1',port:443}).destroy();
    assert.equal(allowed, 1);
    await assert.rejects(fetch('https://external.invalid'), /blocked/);
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {spawnSync} from 'node:child_process';
    const child = spawnSync(process.execPath, ['--input-type=module','-e', "await fetch('https://external.invalid')"], {encoding:'utf8'});
    assert.notEqual(child.status,0);
    assert.match(child.stderr,/Inference blocked/);
  `], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--import=' + guard } })
  assert.equal(child.status, 0, child.stderr)
});
for (const [label, mutate] of [
  ['quoted consumer command', w => { w.jobs['consumer-artifact'].steps.find(s => s.run?.startsWith('npm run test:consumer-artifact')).run = "echo 'npm run test:consumer-artifact'"; }],
  ['consumer excludes Windows', w => { w.jobs['consumer-artifact'].strategy.matrix.exclude = [{ os: 'windows-latest' }]; }],
  ['consumer missing dependency', w => { w.jobs['windows-portability'].needs = w.jobs['windows-portability'].needs.filter(n => n !== 'consumer-artifact'); }],
]) test(label + ' fails closed', () => {
  const changed = structuredClone(workflow);
  mutate(changed);
  assert.throws(() => commandCoverage(changed, 'npm run test:consumer-artifact'));
});

// The staged-asset fixture exercises the actual npm-pack manifest.
const script = fileURLToPath(new URL('../../babel-cli/scripts/stage_runtime_assets.mjs', import.meta.url))
test('stages catalog assets and defaults while removing stale resources and build debris', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel assets ü '))
  const pkg = join(root, 'babel-cli')
  try {
    for (const dir of ['layer', 'config', 'babel-cli/config', 'babel-cli/dist', 'babel-cli/resources']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    writeFileSync(join(root, 'prompt_catalog.yaml'), 'entries:\n  - id: sample\n    path: layer/prompt.md\n')
    writeFileSync(join(root, 'layer/prompt.md'), 'prompt')
    writeFileSync(join(root, 'config/model-policy.json'), '{}')
    writeFileSync(join(root, 'config/private-local.json'), 'private sentinel')
    writeFileSync(join(root, 'babel-cli/config/runtime-mode.json'), '{}')
    writeFileSync(join(root, 'LICENSE'), 'Apache License')
    for (const name of ['index.js', 'unit.test.js', 'index.js.map', 'index.d.ts']) {
      writeFileSync(join(pkg, 'dist', name), '')
    }
    writeFileSync(join(pkg, 'resources/stale.json'), '{}')
    mkdirSync(join(pkg, 'dist/voice'))
    for (const name of ['audio-capture-worker.mjs', 'vad-worker.mjs']) {
      writeFileSync(join(pkg, 'dist/voice', name), '// worker fixture')
    }
    const staged = spawnSync(process.execPath, [script, root, pkg], { encoding: 'utf8' })
    assert.equal(staged.status, 0, staged.stderr)
    assert.equal(readFileSync(join(pkg, 'resources/layer/prompt.md'), 'utf8'), 'prompt')
    for (const file of ['prompt_catalog.yaml', 'config/model-policy.json', 'babel-cli/config/runtime-mode.json']) {
      assert.ok(existsSync(join(pkg, 'resources', file)), file)
    }
    assert.ok(existsSync(join(pkg, 'LICENSE')))
    assert.ok(existsSync(join(pkg, 'dist/index.js')))
    for (const file of ['resources/config/private-local.json', 'resources/stale.json', 'dist/unit.test.js', 'dist/index.js.map', 'dist/index.d.ts']) {
      assert.equal(existsSync(join(pkg, file)), false, file)
    }
    const manifest = JSON.parse(readFileSync(new URL('../../babel-cli/package.json', import.meta.url), 'utf8'))
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...manifest, scripts: {} }))
    mkdirSync(join(pkg, 'bin'))
    writeFileSync(join(pkg, 'bin/babel.js'), '#!/usr/bin/env node\n')
    writeFileSync(join(pkg, '.env'), 'secret=sentinel')
    const npmCli = process.env.npm_execpath || [
      join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
      '/usr/share/nodejs/npm/bin/npm-cli.js',
    ].find(existsSync)
    assert.ok(npmCli, 'npm CLI is available beside the selected Node runtime')
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', join(root, 'npm-cache')], { cwd: pkg, encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const result = JSON.parse(packed.stdout)[0]
    assert.equal(manifest.name, 'babel-harness')
    assert.equal(result.name, 'babel-harness')
    assert.deepEqual(manifest.bin, { 'babel-agent': 'bin/babel.js', 'babel-harness': 'bin/babel.js' })
    const paths = result.files.map(file => file.path)
    for (const file of ['resources/layer/prompt.md', 'LICENSE', 'dist/index.js', 'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs']) assert.ok(paths.includes(file), file)
    assert.ok(!paths.some(path => /\.env|\.test\.|\.map$|\.d\.ts$/.test(path)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
