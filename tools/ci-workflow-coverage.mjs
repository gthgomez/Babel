import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { load } = createRequire(new URL('../babel-cli/package.json', import.meta.url))('js-yaml');
export const parseWorkflow = text => load(text);

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
        if (step.if !== undefined && step.if !== `matrix.os == '${os}'`) {
          const report = step.if.match(/^matrix\.os == '(ubuntu-latest|windows-latest)' && \(always\(\) && steps\.([a-z_]+)\.outcome != 'skipped' && steps\.([a-z_]+)\.outcome != ''\)$/);
          if (!report || report[1] !== os || report[2] !== report[3]) continue;
          const attempted = job.steps.find(s => s.id === report[2]);
          if (!attempted?.run || attempted.if !== undefined || attempted['continue-on-error'] !== undefined) continue;
        }
        if (String(step.run ?? '').includes(command)) providers.push(name);
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
