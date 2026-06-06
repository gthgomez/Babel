import assert from 'node:assert/strict';
import test from 'node:test';

import type { ToolCallRequest } from '../localTools.js';
import {
  buildExecutorTurnPrompt,
  classifyRunnerExhaustionHaltTag,
  shouldForceRecoverableCommandRerun,
  summarizeFileReadForExecutor,
  type PendingRecoverableCommandRetry,
} from './executorHelpers.js';

function pendingRetry(
  patchedTargetKeys: string[] = ['compress.c'],
): PendingRecoverableCommandRetry {
  return {
    tool: 'shell_exec',
    command: 'cat data.comp | ./decomp > output.txt && diff output.txt data.txt',
    failedStep: 7,
    patchedTargetKeys: new Set(patchedTargetKeys),
  };
}

test('recoverable command rerun guard allows inspection after a patch', () => {
  const req: ToolCallRequest = { tool: 'file_read', path: 'compress.c' };

  assert.deepEqual(
    shouldForceRecoverableCommandRerun(pendingRetry(), req, null),
    { force: false, reason: null },
  );
});

test('recoverable command rerun guard forces verifier before repeated patch writes', () => {
  const req: ToolCallRequest = {
    tool: 'file_write',
    path: 'compress.c',
    content: 'int main(void){return 0;}',
  };
  const decision = shouldForceRecoverableCommandRerun(pendingRetry(), req, 'compress.c');

  assert.equal(decision.force, true);
  assert.match(decision.reason ?? '', /rerun/);
  assert.match(decision.reason ?? '', /cat data\.comp/);
});

test('recoverable command rerun guard allows new patch target and exact retry', () => {
  const newPatch: ToolCallRequest = {
    tool: 'file_write',
    path: 'helpers.c',
    content: '/* helper */',
  };
  assert.equal(
    shouldForceRecoverableCommandRerun(pendingRetry(), newPatch, 'helpers.c').force,
    false,
  );

  const retry: ToolCallRequest = {
    tool: 'shell_exec',
    command: 'cat data.comp | ./decomp > output.txt && diff output.txt data.txt',
  };
  assert.equal(
    shouldForceRecoverableCommandRerun(pendingRetry(), retry, null).force,
    false,
  );
});

test('runner exhaustion classifier separates provider failures from hallucinated output', () => {
  assert.equal(
    classifyRunnerExhaustionHaltTag(
      'All runner tiers failed to produce a valid executor turn. Last error: rate limit: [deepInfraApi] HTTP 429 — {"error":{"message":"Model busy, retry later"}}',
    ),
    'TOOL_CALL_ERROR',
  );
  assert.equal(
    classifyRunnerExhaustionHaltTag(
      'All runner tiers failed to produce a valid executor turn. Last error: Zod validation failed for executor turn output',
    ),
    'HALLUCINATED_OUTPUT',
  );
});

test('large JSONL file reads are summarized for executor prompts', () => {
  const jsonl = Array.from({ length: 100 }, (_, index) =>
    JSON.stringify({
      request_id: `req-${String(index).padStart(3, '0')}`,
      prompt_len: 16 + index,
      gen_len: 4 + (index % 8),
      hidden_align: 512,
      heads_align: 8,
    }),
  ).join('\n');

  const summary = summarizeFileReadForExecutor('/project/task_file/requests.jsonl', jsonl);

  assert.ok(summary);
  assert.match(summary, /Large JSONL file summarized/);
  assert.match(summary, /records: 100/);
  assert.match(summary, /prompt_len: min=16/);
  assert.match(summary, /gen_len: min=4/);
  assert.match(summary, /sample_request_ids: req-000/);
  assert.match(summary, /req-099/);
  assert.match(summary, /Do not reconstruct every row/);
});

test('small files stay verbatim while large JSONL cache entries are compressed', () => {
  assert.equal(summarizeFileReadForExecutor('src/index.ts', 'console.log("ok");'), null);

  const jsonl = Array.from({ length: 90 }, (_, index) =>
    JSON.stringify({ request_id: `req-${index}`, prompt_len: index + 1, gen_len: 2 }),
  ).join('\n');
  const prompt = buildExecutorTurnPrompt(
    'base',
    '',
    0,
    new Map([['task_file/requests.jsonl', jsonl]]),
  );

  assert.match(prompt, /FILE_READ_CACHE/);
  assert.match(prompt, /records: 90/);
  assert.doesNotMatch(prompt, /"request_id":"req-50"/);
});
