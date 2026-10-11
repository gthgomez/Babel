import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { load } = createRequire(new URL('../babel-cli/package.json', import.meta.url))('js-yaml');
export const parseWorkflow = text => load(text);

// A closed grammar for the straight-line commands used by the reviewed jobs.
// Script data, functions, branches, substitutions and unknown shell constructs
// cannot establish coverage; extending the grammar requires a reviewed test.
function directlyRuns(script, command) {
  const lines = String(script ?? '').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const supported = [
    /^npm run test:consumer-artifact -- --archive "\$env:CONSUMER_ARCHIVE" --manifest \.\.\/artifacts\/consumer-candidate\/manifest\.json --expected-sha256 "\$env:CONSUMER_DIGEST" --expected-source "\$env:CONSUMER_SOURCE"$/,
    /^npm run [a-z0-9:-]+(?: -- --test-timeout=[0-9]+)?(?: 2>&1 \| Tee-Object(?: -FilePath)? [a-zA-Z0-9_./-]+)?$/,
    /^node scripts\/[a-zA-Z0-9_.-]+\.mjs [a-z0-9-]+$/,
    /^pwsh -NoProfile -ExecutionPolicy Bypass -File tools\/check-harness-architecture\.ps1$/,
    /^New-Item -ItemType Directory -Force (?:\.\.\/)?artifacts\/[a-z0-9-]+ \| Out-Null$/,
    /^exit \$LASTEXITCODE$/,
  ];
  if (!lines.length || lines.some(line => !supported.some(pattern => pattern.test(line)))) return false;
  const exit = lines.indexOf('exit $LASTEXITCODE');
  if (exit >= 0 && exit !== lines.length - 1) return false;
  const target = command === 'check-harness-architecture.ps1'
    ? lines.indexOf('pwsh -NoProfile -ExecutionPolicy Bypass -File tools/check-harness-architecture.ps1')
    : lines.findIndex(line => line === command || line.startsWith(command + ' '));
  // GitHub's built-in shells retain the final native exit status. A later
  // command would overwrite it and cannot prove the required suite is gated.
  return target >= 0 && lines.slice(target + 1).every(line => line === 'exit $LASTEXITCODE');
}

// Deliberately support explicit hosted labels and the reviewed OS matrix only.
// Unknown conditions or matrix exclusions do not establish required coverage.
export function commandCoverage(workflow, command) {
  const result = {};
  for (const [gateName, os] of [['linux-validation', 'ubuntu-latest'], ['windows-portability', 'windows-latest']]) {
    const gate = workflow.jobs?.[gateName];
    assert.ok(gate, `Missing required gate ${gateName}`);
    assert.equal(gate.if, 'always()', `${gateName} must reject skipped dependencies`);
    assert.equal(gate['continue-on-error'], undefined);
    const needs = typeof gate.needs === 'string' ? [gate.needs] : gate.needs;
    assert.ok(Array.isArray(needs) && needs.length > 0, `${gateName}: missing dependencies`);
    const guard = gate.steps?.[0];
    assert.equal(guard?.env?.NEEDS_JSON, '${{ toJSON(needs) }}');
    assert.match(guard?.run ?? '', /\$dependencies\.Count -eq 0/);
    assert.match(guard?.run ?? '', /\$dependency\.Value\.result -ne 'success'/);
    assert.match(guard?.run ?? '', /throw/);
    const providers = [];
    for (const name of needs) {
      const job = workflow.jobs[name];
      if (!job || job.if !== undefined || job['continue-on-error'] !== undefined) continue;
      const matrix = job.strategy?.matrix;
      const platforms = job['runs-on'] === '${{ matrix.os }}'
        ? (!matrix?.include && !matrix?.exclude && Array.isArray(matrix?.os) ? matrix.os : [])
        : [job['runs-on']];
      if (!platforms.includes(os)) continue;
      for (const step of job.steps ?? []) {
        if (step['continue-on-error'] !== undefined) continue;
        const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell
          ?? (os === 'windows-latest' ? 'pwsh' : 'bash');
        // Only built-in runner shells execute this closed command grammar.
        // Custom templates can merely print the script and still succeed.
        if (shell !== 'pwsh' && shell !== 'bash') continue;
        if (step.if !== undefined && step.if !== `matrix.os == '${os}'`) {
          const report = step.if.match(/^matrix\.os == '(ubuntu-latest|windows-latest)' && \(always\(\) && steps\.([a-z_]+)\.outcome != 'skipped' && steps\.([a-z_]+)\.outcome != ''\)$/);
          if (!report || report[1] !== os || report[2] !== report[3]) continue;
          const attempted = job.steps.find(s => s.id === report[2]);
          if (!attempted?.run || attempted.if !== undefined || attempted['continue-on-error'] !== undefined) continue;
        }
        if (directlyRuns(step.run, command)) providers.push(name);
      }
    }
    assert.ok(providers.length > 0, `${gateName}: ${command} has no unconditional ${os} execution dependency`);
    result[os] = [...new Set(providers)];
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, ...commands] = process.argv.slice(2);
  assert.ok(path && commands.length, 'Usage: ci-workflow-coverage.mjs workflow.yml command [...]');
  const workflow = parseWorkflow(readFileSync(path === '-' ? 0 : path, 'utf8'));
  console.log(JSON.stringify(Object.fromEntries(commands.map(command => [command, commandCoverage(workflow, command)]))));
}
