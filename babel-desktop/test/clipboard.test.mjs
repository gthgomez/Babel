// License: Apache-2.0 — see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';

test('clipboard bridge accepts bounded plain text only and never exposes reads',async()=>{
  const {writeClipboardText}=await import('../native/clipboard.mjs');
  const writes=[];
  const clipboard={writeText:text=>writes.push(text)};
  assert.equal(writeClipboardText(clipboard,'line 1\n<code>'),true);
  assert.deepEqual(writes,['line 1\n<code>']);
  for(const invalid of [null,{},42,'','x'.repeat(250001),'bad\0text']) {
    assert.throws(()=>writeClipboardText(clipboard,invalid),/Invalid clipboard text/);
  }
  assert.equal(writes.length,1);
  assert.throws(()=>writeClipboardText({writeText(){throw new Error('unavailable');}},'text'),/Clipboard unavailable/);
});
