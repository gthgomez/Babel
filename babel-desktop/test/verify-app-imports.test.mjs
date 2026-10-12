import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findUnresolvedRelativeImports, assertAppImportsResolve} from '../scripts/lib/verify-app-imports.mjs';

function makeApp(files) {
  const app = mkdtempSync(join(tmpdir(), 'babel-app-imports-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(app, name, '..'), {recursive: true});
    writeFileSync(join(app, name), content);
  }
  return app;
}

test('resolves a complete app tree', () => {
  const app = makeApp({
    'native/main.mjs': "import {x} from '../src/core.mjs';\nimport {y} from './helper.mjs';\nimport('node:fs');\n",
    'native/helper.mjs': "export const y = 1;\n",
    'src/core.mjs': "import './side.mjs';\nexport const x = 2;\n",
    'src/side.mjs': "export {};\n",
  });
  try {
    assert.deepEqual(findUnresolvedRelativeImports(app), []);
    assert.doesNotThrow(() => assertAppImportsResolve(app));
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('reports a missing allowlist target like native importing ../src/core.mjs', () => {
  const app = makeApp({
    'native/sessions.mjs': "import {s} from '../src/core.mjs';\n",
  });
  try {
    const unresolved = findUnresolvedRelativeImports(app);
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0].spec, /src\/core\.mjs/);
    assert.throws(() => assertAppImportsResolve(app), /unresolved relative import/);
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('normalizes .. segments and rejects extensionless imports', () => {
  const app = makeApp({
    'native/a.mjs': "import {b} from '../src/b.mjs';\nimport {c} from '../src/c.mjs';\n",
    'src/b.mjs': "export const b = 1;\n",
  });
  try {
    const unresolved = findUnresolvedRelativeImports(app);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].spec, '../src/c.mjs');
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('ignores package and builtin specifiers', () => {
  const app = makeApp({
    'native/a.mjs': "import {createHash} from 'node:crypto';\nimport x from 'some-package/index.mjs';\nimport y from 'electron';\n",
  });
  try {
    assert.deepEqual(findUnresolvedRelativeImports(app), []);
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});
