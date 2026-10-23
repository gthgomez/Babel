import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCommand } from '../authority/commandDecoder.js';
import { isAuthoritativeVerifierCommand, matchesAuthoritativeVerifierAllowlist } from './completionGatePolicy.js';

test('Node test preloads share dispatch and completion recognition', () => {
  for (const command of [
    'node --import tsx --test src/example.test.ts',
    'node --import ./src/testinfra/register-no-ambient-inference.mjs --import tsx --test --test-reporter=tap --test-concurrency=1 src/research/v2/access/admittedHttpGet.defaultTransport.test.ts',
    'node --import=tsx --test --test-name-pattern="ordinary case" src/example.test.ts',
    'node --test --import tsx src/example.test.ts',
  ]) {
    assert.equal(decodeCommand(command).capability, 'run_tests', command);
    assert.equal(matchesAuthoritativeVerifierAllowlist(command), true, command);
    assert.equal(isAuthoritativeVerifierCommand(command), true, command);
  }
});

test('preloads cannot manufacture a Node test invocation or bypass conservative dispatch parsing', () => {
  for (const command of [
    'node --import tsx script.js --test',
    'node --import --test script.js',
    'node --import tsx --eval "console.log(1)" --test',
    'node --import tsx --test --no-test script.js',
    'node --import tsx --test --no_test script.js',
    'node --import tsx --test --unknown src/example.test.ts',
    'node --import tsx --test --test-name-pattern="$(echo x)" src/example.test.ts',
    'node --import tsx --test --test-name-pattern="%EXPAND%" src/example.test.ts',
    'cmd /c node --import tsx --test src/example.test.ts',
  ]) {
    assert.equal(isAuthoritativeVerifierCommand(command), false, command);
  }
});

test('recognized Node test preloads still reject non-executing and agent-owned proof', () => {
  for (const command of [
    'node --import tsx --test --help',
    'node --import tsx --test --version',
    'node --import tsx --test _verify_fix.js',
    'node --import tsx --test src/example.test.ts || echo passed',
  ]) assert.equal(isAuthoritativeVerifierCommand(command), false, command);
});
