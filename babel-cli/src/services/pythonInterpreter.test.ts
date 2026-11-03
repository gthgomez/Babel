import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPythonBin, pythonCandidates, resolvePythonInterpreter } from './pythonInterpreter.js';

test('prefers python3 then python on POSIX', () => {
  assert.deepEqual(pythonCandidates('linux', {}).map((c) => c.label), ['python3', 'python']);
  assert.equal(defaultPythonBin('darwin'), 'python3');
});

test('prefers py -3 then python on Windows', () => {
  assert.deepEqual(pythonCandidates('win32', {}).map((c) => c.label), ['py -3', 'python', 'python3']);
  assert.equal(defaultPythonBin('win32'), 'python');
});

test('env override is tried first', () => {
  assert.equal(pythonCandidates('linux', { BABEL_PYTHON: '/opt/py/bin/python3' })[0]?.bin, '/opt/py/bin/python3');
});

test('falls back to python when python3 is missing', () => {
  const r = resolvePythonInterpreter({ platform: 'linux', env: {}, probe: (bin) => bin === 'python' });
  assert.equal(r.interpreter?.bin, 'python');
});

test('uses py launcher prefix args on Windows', () => {
  const r = resolvePythonInterpreter({ platform: 'win32', env: {}, probe: (bin) => bin === 'py' });
  assert.deepEqual(r.interpreter, { bin: 'py', prefixArgs: ['-3'], label: 'py -3' });
});

test('returns null with tried list when no interpreter exists', () => {
  const r = resolvePythonInterpreter({ platform: 'linux', env: {}, probe: () => false });
  assert.equal(r.interpreter, null);
  assert.deepEqual(r.tried, ['python3', 'python']);
});
