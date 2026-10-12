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
    assert.equal(unresolved[0].reason, 'missing-module');
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
    assert.equal(unresolved[0].reason, 'missing-module');
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('rejects extensionless imports even when a .mjs sibling exists', () => {
  const app = makeApp({
    'native/main.mjs': "import {h} from './helper';\n",
    'native/helper.mjs': "export const h = 1;\n",
  });
  try {
    const unresolved = findUnresolvedRelativeImports(app);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].spec, './helper');
    assert.equal(unresolved[0].reason, 'extensionless-import');
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('rejects directory imports even when index.mjs exists', () => {
  const app = makeApp({
    'native/main.mjs': "import {x} from './pkg';\n",
    'native/pkg/index.mjs': "export const x = 1;\n",
  });
  try {
    const unresolved = findUnresolvedRelativeImports(app);
    assert.equal(unresolved.length, 1);
    assert.ok(
      unresolved[0].reason === 'extensionless-import' || unresolved[0].reason === 'directory-import',
      `expected extensionless or directory import rejection, got ${unresolved[0].reason}`,
    );
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('rejects trailing-slash directory imports', () => {
  const app = makeApp({
    'native/main.mjs': "import {x} from './pkg/';\n",
    'native/pkg/index.mjs': "export const x = 1;\n",
  });
  try {
    const unresolved = findUnresolvedRelativeImports(app);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].reason, 'directory-import');
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('accepts file URL query and hash suffixes on relative imports', () => {
  const app = makeApp({
    'native/main.mjs': "import {a} from './mod.mjs?v=1';\nimport {b} from './other.mjs#fragment';\n",
    'native/mod.mjs': "export const a = 1;\n",
    'native/other.mjs': "export const b = 2;\n",
  });
  try {
    assert.deepEqual(findUnresolvedRelativeImports(app), []);
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('resolves percent-encoded spaces and Unicode in relative paths', () => {
  const app = makeApp({
    'native/main.mjs': "import {x} from './spaced%20file.mjs';\nimport {y} from './caf%C3%A9.mjs';\n",
    'native/spaced file.mjs': "export const x = 1;\n",
    'native/café.mjs': "export const y = 2;\n",
  });
  try {
    assert.deepEqual(findUnresolvedRelativeImports(app), []);
  } finally {
    rmSync(app, {recursive: true, force: true});
  }
});

test('allows in-app .. imports and rejects escapes outside the packaged root', () => {
  const app = makeApp({
    'native/deep/nested.mjs': "import {ok} from '../../src/ok.mjs';\nimport {bad} from '../../../../outside.mjs';\n",
    'src/ok.mjs': "export const ok = 1;\n",
  });
  try {
    const unresolved = findUnresolvedRelativeImports(app);
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0].spec, /outside\.mjs/);
    assert.equal(unresolved[0].reason, 'outside-app-root');
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
