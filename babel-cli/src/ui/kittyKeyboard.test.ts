/**
 * G7 — Kitty keyboard protocol helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  kittyEnableSequence,
  kittyDisableSequence,
  shouldEnableKittyKeyboard,
  parseKittyCsiU,
  KITTY_FLAGS_DEFAULT,
} from './kittyKeyboard.js';

describe('kittyKeyboard', () => {
  it('enable/disable sequences', () => {
    assert.equal(kittyEnableSequence(3), '\x1b[>3u');
    assert.equal(kittyDisableSequence(), '\x1b[<u');
    assert.ok(kittyEnableSequence().includes(String(KITTY_FLAGS_DEFAULT)));
  });

  it('shouldEnableKittyKeyboard respects caps and env', () => {
    const prev = process.env['BABEL_KITTY_KBD'];
    try {
      delete process.env['BABEL_KITTY_KBD'];
      assert.equal(shouldEnableKittyKeyboard(true), true);
      assert.equal(shouldEnableKittyKeyboard(false), false);
      process.env['BABEL_KITTY_KBD'] = '1';
      assert.equal(shouldEnableKittyKeyboard(false), true);
      process.env['BABEL_KITTY_KBD'] = '0';
      assert.equal(shouldEnableKittyKeyboard(true), false);
    } finally {
      if (prev === undefined) delete process.env['BABEL_KITTY_KBD'];
      else process.env['BABEL_KITTY_KBD'] = prev;
    }
  });

  it('parses printable key CSI u', () => {
    // 'a' = 97
    const ev = parseKittyCsiU('97', '\x1b[97u');
    assert.ok(ev);
    assert.equal(ev!.name, 'a');
    assert.equal(ev!.ctrl, false);
  });

  it('parses ctrl+c as code 99 with mod 5 (1+4)', () => {
    const ev = parseKittyCsiU('99;5', '\x1b[99;5u');
    assert.ok(ev);
    assert.equal(ev!.name, 'c');
    assert.equal(ev!.ctrl, true);
  });

  it('ignores key release events', () => {
    assert.equal(parseKittyCsiU('97;1;3', '\x1b[97;1;3u'), null);
  });

  it('ignores push/pop parameter forms', () => {
    assert.equal(parseKittyCsiU('>1', '\x1b[>1u'), null);
    assert.equal(parseKittyCsiU('<', '\x1b[<u'), null);
  });
});
