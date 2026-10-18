import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationPresentation } from './conversationPresentation.js';
import { suspendActiveRendererForExclusiveSurface } from './rendererFence.js';

test('nested surfaces retain immutable boundaries and only the latest preview per generation', () => {
  const presentation = new ConversationPresentation();
  const paints: string[] = [];
  const outer = suspendActiveRendererForExclusiveSurface();
  const inner = suspendActiveRendererForExclusiveSurface();
  try {
    for (let n = 0; n < 100; n++) presentation.preview(() => { paints.push(`A${n}`); });
    presentation.run(() => { paints.push('seal A'); });
    for (let n = 0; n < 100; n++) presentation.preview(() => { paints.push(`B${n}`); });
    presentation.run(() => { paints.push('seal B'); });
    inner();
    presentation.flush();
    assert.deepEqual(paints, []);
  } finally { inner(); outer(); }
  assert.deepEqual(paints, ['A99', 'seal A', 'B99', 'seal B']);
  presentation.flush();
  assert.equal(paints.length, 4);
});
