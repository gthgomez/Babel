import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requiredChatCreatedFiles, verifyChatCreatedOutputs } from './chatCompletion.js';

test('creation requirements come from affirmative task clauses rather than plan actions', () => {
  assert.deepEqual(requiredChatCreatedFiles('Create first.txt and second.txt. Write a new file called third.txt.'), ['first.txt','second.txt','third.txt']);
  assert.deepEqual(requiredChatCreatedFiles('Read input.txt and create src/output.txt using it.'), ['src/output.txt']);
  assert.deepEqual(requiredChatCreatedFiles('Create wanted.txt. Do not create protected.txt and create another.txt.'), ['wanted.txt']);
  assert.deepEqual(requiredChatCreatedFiles('Explain how to create absent.txt.'), []);
  assert.deepEqual(requiredChatCreatedFiles('Create absent.txt. Do not write any files.'), []);
  assert.deepEqual(requiredChatCreatedFiles('Delete obsolete.txt.'), []);
  assert.deepEqual(requiredChatCreatedFiles('Explain this example:\n```text\nCreate absent.txt.\n```'), []);
  for (const prefix of ['Could you', 'Would you please', 'I want you to', 'I need you to']) {
    assert.deepEqual(requiredChatCreatedFiles(`${prefix} create output.txt containing hello.`), ['output.txt']);
    assert.deepEqual(requiredChatCreatedFiles(`Read input.txt, then ${prefix.toLowerCase()} create output.txt.`), ['output.txt']);
    assert.deepEqual(requiredChatCreatedFiles(`Explain input.txt, then ${prefix.toLowerCase()} create output.txt.`), ['output.txt']);
    assert.deepEqual(requiredChatCreatedFiles(`${prefix} explain how to create absent.txt.`), []);
  }
});

test('missing, unrelated and wrong-content outputs cannot certify creation; correct no-ops and empty files can', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-outputs-'));
  try {
    writeFileSync(join(root,'unrelated.txt'),'hello');
    assert.match(verifyChatCreatedOutputs('Create missing.txt containing hello.',root) ?? '', /missing\.txt/);
    writeFileSync(join(root,'present.txt'),'wrong');
    const task = 'Create present.txt containing the exact string "hello".';
    assert.notEqual(verifyChatCreatedOutputs(task,root),null);
    writeFileSync(join(root,'present.txt'),'hello');
    assert.equal(verifyChatCreatedOutputs(task,root),null,'independent readback proves an existing correct file without a write');
    writeFileSync(join(root,'empty.txt'),'');
    assert.equal(verifyChatCreatedOutputs('Create empty.txt.',root),null);
    writeFileSync(join(root,'empty.txt'),'not empty');
    assert.notEqual(verifyChatCreatedOutputs('Create an empty file named empty.txt.',root),null);
    writeFileSync(join(root,'empty.txt'),'');
    assert.equal(verifyChatCreatedOutputs('Create an empty file named empty.txt.',root),null);
    assert.match(verifyChatCreatedOutputs('Create present.txt and missing.txt.',root) ?? '', /missing\.txt/);
    mkdirSync(join(root,'directory.txt'));
    assert.notEqual(verifyChatCreatedOutputs('Create directory.txt.',root),null);
    assert.notEqual(verifyChatCreatedOutputs('Create ../outside.txt.',root),null);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
