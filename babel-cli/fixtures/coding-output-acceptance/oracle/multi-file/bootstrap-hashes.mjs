#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '../../workspaces/multi-file');
const paths = ['tests/greet.test.js', 'package.json', 'src/decoy.ts'];
// Hash LF-normalized bytes so the tracked oracle is checkout-independent: a
// CRLF working copy must regenerate the committed digests, never rewrite them.
const normalize = (bytes) => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const immutable_paths = {};
for (const rel of paths) {
  immutable_paths[rel] = createHash('sha256').update(normalize(readFileSync(join(templateRoot, rel)))).digest('hex');
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'expected-hashes.json');
writeFileSync(out, JSON.stringify({ immutable_paths }, null, 2) + '\n');
