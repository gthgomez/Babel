#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = process.argv[2];
if (!workspace) {
  console.error('usage: score.mjs <agent-workspace>');
  process.exit(2);
}

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '../../workspaces/multi-file');

execFileSync('npm', ['test'], { cwd: workspace, stdio: 'inherit', windowsHide: true });

assert.match(
  readFileSync(join(workspace, 'src/greet.ts'), 'utf8'),
  /Hello,\s*\$\{name\}!/,
);
assert.match(readFileSync(join(workspace, 'src/index.ts'), 'utf8'), /formatGreeting/);

for (const rel of ['src/decoy.ts', 'package.json']) {
  const expected = readFileSync(join(templateRoot, rel), 'utf8');
  const actual = readFileSync(join(workspace, rel), 'utf8');
  assert.equal(
    createHash('sha256').update(actual).digest('hex'),
    createHash('sha256').update(expected).digest('hex'),
    `${rel} must remain unchanged`,
  );
}

console.log(JSON.stringify({ functional_success: true, oracle: 'multi-file' }));
