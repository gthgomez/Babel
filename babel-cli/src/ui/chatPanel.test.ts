import assert from 'node:assert/strict';
import test from 'node:test';

import { renderChatTranscript, renderChatTurn } from './chatPanel.js';
import { stripAnsi } from './theme.js';

test('renderChatTurn wraps long assistant answers instead of truncating', () => {
  const longAnswer =
    'This repository is a prompt operating system that assembles instruction stacks for agent workflows and keeps governance visible during daily CLI use.';
  const rendered = stripAnsi(
    renderChatTurn({
      role: 'assistant',
      answer: longAnswer,
    }),
  );
  assert.match(rendered, /Babel/);
  assert.match(rendered, /prompt operating system/);
  assert.doesNotMatch(rendered, /\.\.\./);
});

test('renderChatTranscript shows recent turns with transcript path', () => {
  const rendered = stripAnsi(
    renderChatTranscript(
      [
        { role: 'user', input: 'what is this repo?' },
        { role: 'assistant', answer: 'A prompt operating system.' },
      ],
      {
        transcriptPath: 'C:/runs/interactive-sessions/demo/transcript.jsonl',
        maxTurns: 12,
      },
    ),
  );
  assert.match(rendered, /Chat Transcript/);
  assert.match(rendered, /what is this repo/);
  assert.match(rendered, /prompt operating system/);
  assert.match(rendered, /transcript\.jsonl/);
});
