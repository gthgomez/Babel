import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rewriteArgv } from './argv.js';

describe('rewriteArgv', () => {
  it('preserves execution profile values for run commands', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'run', '--execution-profile', 'benchmark_container', 'write the report']),
      ['node', 'babel', 'run', '--execution-profile', 'benchmark_container', 'write the report'],
    );
  });

  it('keeps execution profile help calls from treating --help as a profile value', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'run', '--execution-profile', 'benchmark_container', '--help']),
      ['node', 'babel', 'run', '--execution-profile', 'benchmark_container', '--help'],
    );
  });

  it('preserves project-root values for manager run commands', () => {
    assert.deepEqual(
      rewriteArgv([
        'node',
        'babel',
        'run',
        'noop',
        '--execution-profile',
        'workspace_manager',
        '--project-root',
        'C:\\Repos\\scratch\\hello-cli',
        '--json',
      ]),
      [
        'node',
        'babel',
        'run',
        '--execution-profile',
        'workspace_manager',
        '--project-root',
        'C:\\Repos\\scratch\\hello-cli',
        '--json',
        'noop',
      ],
    );
  });

  it('maps bl ask to the dedicated Lite command with positional task text', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'ask', 'why is this failing?']),
      [
        'node',
        'bl',
        'lite',
        'ask',
        'why is this failing?',
      ],
    );
  });

  it('maps bl fix to the Lite patch alias path', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'fix', 'repair the CLI help']),
      [
        'node',
        'bl',
        'lite',
        'fix',
        'repair the CLI help',
      ],
    );
  });

  it('maps bl do to the Lite command path', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'do', 'fix the failing test']),
      ['node', 'bl', 'lite', 'do', 'fix the failing test'],
    );
  });

  it('keeps babel lite patch on the dedicated Lite command path', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'lite', 'patch', 'fix the parser test']),
      ['node', 'babel', 'lite', 'patch', 'fix the parser test'],
    );
  });

  it('keeps babel l plan on the Lite alias command path', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'l', 'plan', 'split Babel and Lite']),
      ['node', 'babel', 'l', 'plan', 'split Babel and Lite'],
    );
  });

  it('maps a bare quoted task to the daily do lane', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'fix failing tests']),
      ['node', 'babel', 'do', 'fix failing tests'],
    );
  });

  it('maps bare bl task to lite do lane', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'fix failing tests']),
      ['node', 'bl', 'lite', 'do', 'fix failing tests'],
    );
  });

  it('maps bl propose to lite propose', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'propose', 'smallest safe diff']),
      ['node', 'bl', 'lite', 'propose', 'smallest safe diff'],
    );
  });

  it('maps bl review and undo to lite commands', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'review']),
      ['node', 'bl', 'lite', 'review'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'undo']),
      ['node', 'bl', 'lite', 'undo'],
    );
  });

  it('keeps top-level user verbs as commands', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'fix', 'repair the parser']),
      ['node', 'babel', 'fix', 'repair the parser'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'do', 'repair the parser']),
      ['node', 'babel', 'do', 'repair the parser'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'full', 'harden the implementation plan']),
      ['node', 'babel', 'full', 'harden the implementation plan'],
    );
  });

  it('keeps continue and bench smoke as command surfaces', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'continue', 'latest']),
      ['node', 'babel', 'continue', 'latest'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'continue', 'latest']),
      ['node', 'bl', 'lite', 'continue', 'latest'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'bl', 'resume', 'latest']),
      ['node', 'bl', 'lite', 'resume', 'latest'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'bench', 'smoke', '--json']),
      ['node', 'babel', 'bench', 'smoke', '--json'],
    );
  });

  it('keeps resolve on the canonical resolver command surface', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'resolve', '--task-category', 'frontend', '--json']),
      ['node', 'babel', 'resolve', '--task-category', 'frontend', '--json'],
    );
  });

  it('keeps maintenance commands on their command surfaces', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'simplify', '--all', '--json']),
      ['node', 'babel', 'simplify', '--all', '--json'],
    );
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'docs', 'audit', '--json']),
      ['node', 'babel', 'docs', 'audit', '--json'],
    );
  });
});
