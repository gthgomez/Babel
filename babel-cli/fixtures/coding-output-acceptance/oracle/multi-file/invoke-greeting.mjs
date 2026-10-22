#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const workspace = process.argv[2];
if (!workspace) {
  console.error('usage: invoke-greeting.mjs <agent-workspace>');
  process.exit(2);
}

const mod = await import(pathToFileURL(join(workspace, 'src/index.ts')).href);
assert.equal(typeof mod.formatGreeting, 'function');
assert.equal(mod.formatGreeting('Babel'), 'Hello, Babel!');
assert.equal(mod.formatGreeting('World'), 'Hello, World!');
