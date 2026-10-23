#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '../../workspaces/multi-file');
const paths = ['tests/greet.test.js', 'package.json', 'src/decoy.ts'];
const immutable_paths = {};
for (const rel of paths) {
  const bytes = readFileSync(join(templateRoot, rel));
  immutable_paths[rel] = createHash('sha256').update(bytes).digest('hex');
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'expected-hashes.json');
writeFileSync(out, JSON.stringify({ immutable_paths }, null, 2) + '\n');
