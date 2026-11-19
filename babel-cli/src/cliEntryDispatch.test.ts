import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { isVersionProbe } from './cliEntryDispatch.js';

test('only a bare --version/-V probes the version', () => {
  assert.equal(isVersionProbe(['node', 'babel.js', '--version']), true);
  assert.equal(isVersionProbe(['node', 'babel.js', '-V']), true);
  assert.equal(isVersionProbe(['node', 'babel.js']), false);
  assert.equal(isVersionProbe(['node', 'babel.js', '--version', 'extra']), false);
  assert.equal(isVersionProbe(['node', 'babel.js', '--help']), false);
});

test('a version probe loads no command modules', () => {
  // UX-19: the probe used to import the whole command graph (~4.5k modules).
  const probe = `let modules = 0;
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.startsWith('file:')) modules += 1;
      return result;
    }});
    const { dispatchExecutableCli } = await import(${JSON.stringify(new URL('./cliEntryDispatch.ts', import.meta.url).href)});
    const before = modules;
    await dispatchExecutableCli(['node', 'babel.js', '--version']);
    process.stderr.write('MODULES=' + (modules - before) + '\\n');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const match = /MODULES=(\d+)/.exec(result.stderr);
  assert.ok(match, result.stderr);
  assert.ok(Number(match[1]) < 60, `version probe loaded ${match[1]} modules`);
});
