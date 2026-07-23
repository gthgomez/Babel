import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const commandsPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'commands.ts');

test('commands router wires /fork and /rewind to threadBranch handlers', () => {
  const source = readFileSync(commandsPath, 'utf8');
  assert.match(source, /import \{ handleFork, handleRewind \} from '\.\/commands\/threadBranch\.js'/);
  assert.match(source, /case 'fork':[\s\S]*await handleFork\(ctx, args\)/);
  assert.match(source, /case 'rewind':[\s\S]*await handleRewind\(ctx, args\)/);
});