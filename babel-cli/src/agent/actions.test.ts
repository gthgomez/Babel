import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentActionParseError, agentActionParser, parseAgentActions } from './actions.js';

describe('parseAgentActions', () => {
  it('parses a fenced JSON actions array', () => {
    const raw = [
      'Here is the next step:',
      '```json',
      JSON.stringify({
        actions: [
          { type: 'read_file', path: 'src/index.ts' },
          { type: 'finish', summary: 'done', verification: ['npm test'] },
        ],
      }),
      '```',
    ].join('\n');

    const actions = parseAgentActions(raw);
    assert.equal(actions.length, 2);
    assert.equal(actions[0]?.type, 'read_file');
    assert.equal(actions[1]?.type, 'finish');
    assert.deepEqual(actions[1], {
      type: 'finish',
      summary: 'done',
      verification: ['npm test'],
    });
  });

  it('normalizes executor tool aliases from providers', () => {
    const actions = parseAgentActions({
      actions: [
        { tool: 'file_read', path: 'README.md' },
        { tool: 'directory_list', path: 'src' },
        { tool: 'semantic_search', query: 'checkpoint restore' },
        { tool: 'grep', pattern: 'session_loop', path: 'src' },
        { tool: 'glob', pattern: 'src/**/*.ts' },
        { tool: 'file_write', path: 'out.txt', content: 'hello' },
        { tool: 'shell_exec', command: 'npm test', working_directory: 'babel-cli' },
      ],
    });

    assert.deepEqual(actions, [
      { type: 'read_file', path: 'README.md' },
      { type: 'list_dir', path: 'src' },
      { type: 'search', query: 'checkpoint restore' },
      { type: 'grep', pattern: 'session_loop', path: 'src' },
      { type: 'glob', pattern: 'src/**/*.ts' },
      { type: 'write_file', path: 'out.txt', content: 'hello' },
      {
        type: 'run_command',
        command: 'npm test',
        cwd: 'babel-cli',
      },
    ]);
  });

  it('parses nested ask_approval actions', () => {
    const actions = parseAgentActions({
      action: {
        type: 'ask_approval',
        reason: 'mutation required',
        requested_action: {
          type: 'write_file',
          path: 'src/math.js',
          content: 'export const add = (a, b) => a + b;\n',
        },
      },
    });

    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.type, 'ask_approval');
    if (actions[0]?.type === 'ask_approval') {
      assert.equal(actions[0].requested_action.type, 'write_file');
    }
  });

  it('throws a typed error for invalid payloads', () => {
    assert.throws(
      () => parseAgentActions('not json at all'),
      (error: unknown) => error instanceof AgentActionParseError,
    );
    assert.throws(
      () => parseAgentActions({ actions: [{ type: 'read_file' }] }),
      (error: unknown) => error instanceof AgentActionParseError,
    );
  });

  it('exposes agentActionParser compatible with ActionParser', () => {
    const actions = agentActionParser.parse('{"actions":[{"type":"search","query":"undo"}]}');
    assert.deepEqual(actions, [{ type: 'search', query: 'undo' }]);
  });
});
