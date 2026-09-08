import assert from 'node:assert/strict';
import test from 'node:test';
import { safeReviewPath, secretRiskReviewPath } from './babelReviewSnapshot.js';
test('review snapshot rejects traversal and credentials while permitting public templates', () => {
  for (const value of ['../x', 'a/../x', '/x', 'C:/x', 'a\\b', 'a//b']) assert.equal(safeReviewPath(value), false);
  for (const value of ['.env', 'nested/.env.local', 'auth.json', 'key.pem', '.npmrc']) assert.equal(secretRiskReviewPath(value), true);
  assert.equal(secretRiskReviewPath('babel-cli/.env.example'), false);
  assert.equal(safeReviewPath('src/add.ts'), true);
});
