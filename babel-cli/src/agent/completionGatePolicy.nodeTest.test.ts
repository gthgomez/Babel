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

test('Python test modules share isolated dispatch and authoritative receipt recognition', () => {
  for (const command of [
    'python -m doctest solution.py',
    'python3.11 -m doctest solution.py -v',
    'python -m unittest test_solution -v',
    'python3.12 -m unittest discover -s tests',
    'python -m pytest tests/',
    'python.exe -m unittest test_solution',
    'py -3.11 -m unittest test_solution',
  ]) {
    assert.equal(decodeCommand(command).capability, 'run_tests', command);
    assert.equal(decodeCommand(command).requiresIsolation, true, command);
    assert.equal(matchesAuthoritativeVerifierAllowlist(command), true, command);
    assert.equal(isAuthoritativeVerifierCommand(command), true, command);
  }
});

test('Python inline, unrelated, and shell-expanded commands cannot mint verifier authority', () => {
  for (const command of [
    'python -c "print(1)"',
    'python -m doctestx solution.py',
    'python -m unittest_extra test_solution',
    'python -m doctest solution.py && python -c "print(1)"',
    'python -m unittest %TEST_ARGS%',
    'python3.11 -m doctest !TEST_ARGS!',
    'python3.11 -m unittest --version',
    'python3.11 -m unittest --version=true',
    'python3.11 -m unittest --help',
    'python3.11 -m doctest --usage',
    'python3.11 -m pytest --collect-only',
    String.raw`C:\Python311\python.exe -m doctest solution.py`,
  ]) {
    assert.equal(isAuthoritativeVerifierCommand(command), false, command);
  }
});
