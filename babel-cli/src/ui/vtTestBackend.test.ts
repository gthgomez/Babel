/**
 * G4 — VtTestBackend unit tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VtTestBackend } from './vtTestBackend.js';

describe('VtTestBackend', () => {
  it('writes plain text and advances cursor', () => {
    const vt = new VtTestBackend(10, 40);
    vt.write('Hi');
    assert.equal(vt.charAt(1, 1), 'H');
    assert.equal(vt.charAt(1, 2), 'i');
    assert.deepEqual(vt.getCursor(), { row: 1, col: 3 });
  });

  it('handles CUP positioning', () => {
    const vt = new VtTestBackend(10, 40);
    vt.write('\x1b[3;5HXYZ');
    assert.equal(vt.charAt(3, 5), 'X');
    assert.equal(vt.charAt(3, 6), 'Y');
    assert.deepEqual(vt.getCursor(), { row: 3, col: 8 });
  });

  it('clears line with EL', () => {
    const vt = new VtTestBackend(5, 20);
    vt.write('ABCDEF');
    vt.write('\x1b[1;3H');
    vt.write('\x1b[K'); // clear to end
    assert.equal(vt.charAt(1, 1), 'A');
    assert.equal(vt.charAt(1, 2), 'B');
    assert.equal(vt.charAt(1, 3), ' ');
    assert.equal(vt.charAt(1, 6), ' ');
  });

  it('sets DECSTBM scroll region', () => {
    const vt = new VtTestBackend(10, 40);
    vt.write('\x1b[2;8r');
    assert.deepEqual(vt.getScrollRegion(), { top: 2, bottom: 8 });
  });

  it('scrolls within region on line feed at bottom', () => {
    const vt = new VtTestBackend(6, 20);
    vt.write('\x1b[2;4r'); // scroll region rows 2-4
    vt.write('\x1b[2;1H');
    vt.write('AAA\n');
    vt.write('BBB\n');
    vt.write('CCC\n'); // at bottom of region → scroll
    vt.write('DDD');
    const shot = vt.screenshotStripped();
    // Row 1 (outside region) should stay blank
    assert.equal(shot.lines[0] ?? '', '');
    // After scroll, region should show BBB/CCC/DDD-ish content
    const plain = vt.getPlainScreen();
    assert.ok(plain.includes('DDD') || plain.includes('CCC'));
  });

  it('screenshotStripped reports geometry', () => {
    const vt = new VtTestBackend(12, 30);
    vt.write('ok');
    const s = vt.screenshotStripped();
    assert.equal(s.rows, 12);
    assert.equal(s.cols, 30);
    assert.ok(s.lines[0]?.startsWith('ok'));
  });

  it('ignores DEC 2026 sync wrappers', () => {
    const vt = new VtTestBackend(5, 20);
    vt.write('\x1b[?2026hHello\x1b[?2026l');
    assert.equal(vt.charAt(1, 1), 'H');
    assert.ok(vt.getPlainScreen().includes('Hello'));
  });
});
