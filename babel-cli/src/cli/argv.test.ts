import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rewriteArgv as rewrite } from './argv.js';
import { createCliProgram } from '../cliMain.js';
const registered = new Set(createCliProgram().commands.flatMap(command => [command.name(), ...command.aliases()]));
const rewriteArgv = (argv: string[], names: ReadonlySet<string> = registered) => rewrite(argv, names);

describe('rewriteArgv', () => {
  it('uses actual registrations for exec, daemon, goal and provider help', () => {
    for (const name of ['exec', 'daemon', 'goal', 'provider']) {
      const args = ['node', 'babel', name, '--help']; assert.deepEqual(rewriteArgv(args), args)
    }
  })
  it('accepts standard review and rejects invalid review values', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'work', '--review', 'standard', 'explain']), ['node', 'babel', 'run', '--mode', 'chat', '--review', 'standard', 'explain']);
    assert.throws(() => rewriteArgv(['node', 'babel', 'work', '--review', 'invalid', 'explain']), /standard or thorough/);
  });
  it('routes explicit execution recovery and headless Work', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'run', 'resume', 'latest']), ['node', 'babel', 'continue', 'latest'])
    assert.deepEqual(rewriteArgv(['node', 'babel', 'work', '--headless', 'explain']), ['node', 'babel', 'run', '--mode', 'chat', '--headless', 'explain'])
  })
  it('uses registered command names instead of rewriting them into task prose', () => {
    for (const command of ['exec', 'daemon', 'goal', 'provider', 'model', 'settings']) {
      const args = ['node', 'babel', command, '--help']
      assert.deepEqual(rewriteArgv(args, new Set([command])), args)
    }
  })
  it('keeps execution scope and resume identity separate from the task',()=>{
    const args=['node','babel','run','--mode','chat','--execution-scope','conversation','--resume-chat','session-123','--','Hello again'];
    assert.deepEqual(rewriteArgv(args),args);
  });
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
        'workspace_manager',
        '--project-root',
        '/tmp/scratch\\hello-cli',
        '--json',
      ]),
      [
        'node',
        'babel',
        'run',
        '--execution-profile',
        'workspace_manager',
        '--project-root',
        '/tmp/scratch\\hello-cli',
        '--json',
        'noop',
      ],
    );
  });

  it('maps a bare quoted task to run without overriding saved workflow preferences', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'fix failing tests']), [
      'node',
      'babel',
      'run',
      'fix failing tests',
    ]);
  });

  it('keeps headless presentation separate from the chat workflow', () => {
    assert.deepEqual(rewriteArgv(['node', 'babel', 'chat', '--headless', 'run benchmark']), [
      'node',
      'babel',
      'run',
      '--mode',
      'chat',
      '--headless',
      'run benchmark',
    ]);
  });

  it('preserves the explicit workflow alongside headless presentation', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'run', '--mode', 'chat', '--headless', 'fix it']),
      ['node', 'babel', 'run', '--mode', 'chat', '--headless', 'fix it'],
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

  it('preserves remote serve instead of rewriting it into run', () => {
    assert.deepEqual(
      rewriteArgv(['node', 'babel', 'remote', 'serve', '--port', '4545', '--project', 'C:/tmp/ws']),
      ['node', 'babel', 'remote', 'serve', '--port', '4545', '--project', 'C:/tmp/ws'],
    );
  });
});
