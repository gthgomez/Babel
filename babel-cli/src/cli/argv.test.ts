import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rewriteArgv } from './argv.js';

describe('rewriteArgv', () => {
  it('preserves execution profile values for run commands', () => {
    assert.deepEqual(
      rewriteArgv([
        'node',
        'babel',
        'run',
        '--execution-profile',
        'benchmark_container',
        'write the report',
      ]),
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
        'opencalw_manager',
        '--project-root',
        '/tmp/scratch\\hello-cli',
        '--json',
      ]),
      [
        'node',
        'babel',
        'run',
        '--execution-profile',
        'opencalw_manager',
        '--project-root',
        '/tmp/scratch\\hello-cli',
        '--json',
        'noop',
      ],
    );
  });

  it('maps a bare quoted task to run chat mode', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'fix failing tests']), [
      'node',
      'babel',
      'run',
      '--mode',
      'chat',
      'fix failing tests',
    ]);
  });

  it('maps chat --headless to run --mode chat-headless (hybrid P3.2)', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'chat', '--headless', 'run benchmark']), [
      'node',
      'babel',
      'run',
      '--mode',
      'chat-headless',
      'run benchmark',
    ]);
  });

  it('maps run --mode chat --headless to chat-headless', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'run', '--mode', 'chat', '--headless', 'fix it']),
      ['node', 'babel', 'run', '--mode', 'chat-headless', 'fix it'],
    );
  });

  it('maps chat-headless to run --mode chat-headless', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'chat-headless', 'run benchmark']), [
      'node',
      'babel',
      'run',
      '--mode',
      'chat-headless',
      'run benchmark',
    ]);
  });

  it('keeps deprecated surface commands for pre-parse shim handling', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'lite', 'ask', 'why is this failing?']), [
      'node',
      'babel',
      'lite',
      'ask',
      'why is this failing?',
    ]);
    assert.deepEqual(rewriteArgv(['node', 'babel', 'full', 'harden the implementation plan']), [
      'node',
      'babel',
      'full',
      'harden the implementation plan',
    ]);
    assert.deepEqual(rewriteArgv(['node', 'babel', 'bl', 'fix failing tests']), [
      'node',
      'babel',
      'bl',
      'fix failing tests',
    ]);
  });

  it('keeps top-level user verbs as commands', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'deep', 'harden the implementation plan']), [
      'node',
      'babel',
      'deep',
      'harden the implementation plan',
    ]);
    assert.deepEqual(rewriteArgv(['node', 'babel', 'plan', 'compare the options']), [
      'node',
      'babel',
      'plan',
      'compare the options',
    ]);
  });

  it('keeps continue and bench smoke as command surfaces', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'continue', 'latest']), [
      'node',
      'babel',
      'continue',
      'latest',
    ]);
    assert.deepEqual(rewriteArgv(['node', 'babel', 'bench', 'smoke', '--json']), [
      'node',
      'babel',
      'bench',
      'smoke',
      '--json',
    ]);
  });

  it('keeps resolve on the canonical resolver command surface', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'resolve', '--task-category', 'frontend', '--json']),
      ['node', 'babel', 'resolve', '--task-category', 'frontend', '--json'],
    );
  });

  it('keeps maintenance commands on their command surfaces', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'simplify', '--all', '--json']), [
      'node',
      'babel',
      'simplify',
      '--all',
      '--json',
    ]);
    assert.deepEqual(rewriteArgv(['node', 'babel', 'docs', 'audit', '--json']), [
      'node',
      'babel',
      'docs',
      'audit',
      '--json',
    ]);
  });
});
