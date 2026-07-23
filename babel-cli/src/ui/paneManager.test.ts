/**
 * paneManager.test.ts — Tests for the PaneManager singleton and Pane class.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PaneManager, Pane } from './paneManager.js';
import { OutputBuffer } from './outputBuffer.js';
import type { KeyEvent } from './keyInput.js';

function emptyContent(): string { return ''; }
function labelContent(label: string): () => string { return () => label; }
function makeKey(name: string, ctrl = false, shift = false): KeyEvent {
  return { name, ctrl, shift, meta: false, sequence: name };
}

beforeEach(() => { PaneManager.resetInstance(); });
afterEach(() => { PaneManager.resetInstance(); OutputBuffer.resetInstance(); });

describe('Pane class', () => {
  it('creates with auto-generated ID', () => {
    const pane = new Pane(emptyContent);
    assert.ok(pane.id.startsWith('pane-'));
  });
  it('creates with explicit ID', () => {
    const pane = new Pane(emptyContent, { id: 'my-pane' });
    assert.equal(pane.id, 'my-pane');
  });
  it('defaults to focusable, non-modal, non-floating, closable', () => {
    const pane = new Pane(emptyContent);
    assert.equal(pane.focusable, true);
    assert.equal(pane.modal, false);
    assert.equal(pane.floating, false);
    assert.equal(pane.closable, true);
  });
  it('respects option overrides', () => {
    const pane = new Pane(emptyContent, { focusable: false, modal: true, floating: true, closable: false, title: 'Test' });
    assert.equal(pane.focusable, false);
    assert.equal(pane.modal, true);
    assert.equal(pane.floating, true);
    assert.equal(pane.closable, false);
    assert.equal(pane.title, 'Test');
  });
  it('starts active with null region and zIndex 0', () => {
    const pane = new Pane(emptyContent);
    assert.equal(pane.active, true);
    assert.equal(pane.region, null);
    assert.equal(pane.zIndex, 0);
  });
});

describe('PaneManager — Singleton', () => {
  it('returns same instance', () => {
    assert.strictEqual(PaneManager.instance, PaneManager.instance);
  });
  it('resetInstance clears singleton', () => {
    const a = PaneManager.instance;
    PaneManager.resetInstance();
    assert.notStrictEqual(a, PaneManager.instance);
  });
  it('starts with empty state', () => {
    const pm = PaneManager.instance;
    assert.equal(pm.panes.size, 0);
    assert.equal(pm.dockedPaneIds.length, 0);
    assert.equal(pm.floatingPaneIds.length, 0);
    assert.equal(pm.focusedPaneId, null);
    assert.equal(pm.layoutTree, null);
  });
});

describe('PaneManager — Creation', () => {
  it('createPane adds docked pane and auto-focuses', () => {
    const pm = PaneManager.instance;
    const pane = pm.createPane(emptyContent);
    assert.equal(pm.panes.size, 1);
    assert.ok(pm.dockedPaneIds.includes(pane.id));
    assert.equal(pane.floating, false);
    assert.equal(pm.focusedPaneId, pane.id);
  });
  it('createPane does not focus non-focusable panes', () => {
    const pm = PaneManager.instance;
    pm.createPane(emptyContent, { focusable: false });
    assert.equal(pm.focusedPaneId, null);
  });
  it('createFloating adds a floating pane', () => {
    const pm = PaneManager.instance;
    const pane = pm.createFloating(emptyContent);
    assert.ok(pm.floatingPaneIds.includes(pane.id));
    assert.equal(pane.floating, true);
  });
  it('createModal adds modal with elevated Z-index', () => {
    const pm = PaneManager.instance;
    pm.createPane(emptyContent);
    const modal = pm.createModal(emptyContent);
    assert.equal(modal.modal, true);
    assert.ok(modal.zIndex >= 100);
    assert.equal(pm.focusedPaneId, modal.id);
  });
  it('stackModal pushes on top of existing modals', () => {
    const pm = PaneManager.instance;
    const m1 = pm.createModal(emptyContent);
    const m2 = pm.stackModal(emptyContent);
    assert.ok(m2.zIndex > m1.zIndex);
    assert.equal(pm.focusedPaneId, m2.id);
  });
});

describe('PaneManager — Focus', () => {
  it('focusPane blurs previous and focuses new', () => {
    const pm = PaneManager.instance;
    let blurred = false, focused = false;
    pm.createPane(emptyContent, { id: 'p1', onBlur: () => { blurred = true; } });
    const p2 = pm.createPane(emptyContent, { id: 'p2', onFocus: () => { focused = true; } });
    pm.focusPane(p2.id);
    assert.equal(blurred, true);
    assert.equal(focused, true);
  });
  it('focusPane ignores non-focusable panes', () => {
    const pm = PaneManager.instance;
    pm.createPane(emptyContent, { focusable: false, id: 'nf' });
    pm.focusPane('nf');
    assert.equal(pm.focusedPaneId, null);
  });
  it('focusNext cycles through panes and wraps', () => {
    const pm = PaneManager.instance;
    const p1 = pm.createPane(emptyContent, { id: 'a' });
    const p2 = pm.createPane(emptyContent, { id: 'b' });
    const p3 = pm.createPane(emptyContent, { id: 'c' });
    // First-created focusable pane gets auto-focused (p1, not p3)
    assert.equal(pm.focusedPaneId, p1.id);
    pm.focusNext();
    assert.equal(pm.focusedPaneId, p2.id);
    pm.focusNext();
    assert.equal(pm.focusedPaneId, p3.id);
    pm.focusNext(); // wraps back to first
    assert.equal(pm.focusedPaneId, p1.id);
  });
  it('focusPrevious cycles backward', () => {
    const pm = PaneManager.instance;
    const p1 = pm.createPane(emptyContent, { id: 'a' });
    pm.createPane(emptyContent, { id: 'b' });
    pm.createPane(emptyContent, { id: 'c' });
    pm.focusPane(p1.id);
    pm.focusPrevious();
    assert.notEqual(pm.focusedPaneId, null);
    assert.notEqual(pm.focusedPaneId, p1.id);
  });
  it('closePane returns focus to previous when modal dismissed', () => {
    const pm = PaneManager.instance;
    const docked = pm.createPane(emptyContent, { id: 'docked' });
    const modal = pm.createModal(emptyContent, { id: 'modal' });
    assert.equal(pm.focusedPaneId, modal.id);
    pm.closePane(modal.id);
    assert.equal(pm.focusedPaneId, docked.id);
  });
});

describe('PaneManager — Splits', () => {
  it('splitPane horizontal creates new pane and layout tree', () => {
    const pm = PaneManager.instance;
    const orig = pm.createPane(emptyContent, { id: 'orig' });
    const { existing, new: np } = pm.splitPane(orig.id, 'horizontal', emptyContent);
    assert.ok(existing);
    assert.ok(np);
    assert.ok(pm.dockedPaneIds.includes(np.id));
    assert.notEqual(pm.layoutTree, null);
  });
  it('splitPane vertical works', () => {
    const pm = PaneManager.instance;
    const orig = pm.createPane(emptyContent);
    const { new: np } = pm.splitPane(orig.id, 'vertical', emptyContent);
    assert.ok(np);
  });
  it('splitPane throws for unknown pane', () => {
    assert.throws(() => PaneManager.instance.splitPane('nope', 'horizontal', emptyContent));
  });
  it('splitPane throws for floating pane', () => {
    const pm = PaneManager.instance;
    const f = pm.createFloating(emptyContent);
    assert.throws(() => pm.splitPane(f.id, 'horizontal', emptyContent));
  });
  it('splitPane focuses new pane', () => {
    const pm = PaneManager.instance;
    const orig = pm.createPane(emptyContent);
    const { new: np } = pm.splitPane(orig.id, 'horizontal', emptyContent);
    assert.equal(pm.focusedPaneId, np.id);
  });
});

describe('PaneManager — Close', () => {
  it('closePane removes pane and calls onClose', () => {
    const pm = PaneManager.instance;
    let closed = false;
    const p = pm.createPane(emptyContent, { onClose: () => { closed = true; } });
    pm.closePane(p.id);
    assert.equal(pm.panes.has(p.id), false);
    assert.equal(closed, true);
  });
  it('closePane no-op for unknown pane', () => {
    PaneManager.instance.closePane('nope');
    assert.ok(true);
  });
  it('closePane of last docked clears layout tree', () => {
    const pm = PaneManager.instance;
    const p = pm.createPane(emptyContent);
    pm.closePane(p.id);
    assert.equal(pm.layoutTree, null);
  });
  it('closeAll clears everything including all onClose calls', () => {
    const pm = PaneManager.instance;
    let count = 0;
    pm.createPane(emptyContent, { onClose: () => { count++; } });
    pm.createPane(emptyContent, { onClose: () => { count++; } });
    pm.createFloating(emptyContent, { onClose: () => { count++; } });
    pm.createModal(emptyContent, { onClose: () => { count++; } });
    pm.closeAll();
    assert.equal(pm.panes.size, 0);
    assert.equal(pm.focusedPaneId, null);
    assert.equal(pm.layoutTree, null);
    assert.equal(count, 4);
  });
  it('closeAll safe when empty', () => {
    PaneManager.instance.closeAll();
    assert.ok(true);
  });
});

describe('PaneManager — Key handling', () => {
  it('handleKey returns false with no panes', () => {
    assert.equal(PaneManager.instance.handleKey(makeKey('a')), false);
  });

  it('handleKey routes to floating handler before docked', () => {
    const pm = PaneManager.instance;
    let fh = false, dh = false;
    const dp = pm.createPane(() => '');
    dp.handleKey = () => { dh = true; return true; };
    const fp = pm.createFloating(() => '');
    fp.handleKey = () => { fh = true; return true; };
    pm.handleKey(makeKey('x'));
    assert.equal(fh, true);
    assert.equal(dh, false);
  });

  it('handleKey falls through to docked when floating does not consume', () => {
    const pm = PaneManager.instance;
    let dh = false;
    const dp = pm.createPane(() => '');
    dp.handleKey = () => { dh = true; return true; };
    const fp = pm.createFloating(() => '');
    fp.handleKey = () => false;
    pm.handleKey(makeKey('x'));
    assert.equal(dh, true);
  });

  it('handleKey returns false when nothing consumes', () => {
    const pm = PaneManager.instance;
    pm.createPane(() => '');
    assert.equal(pm.handleKey(makeKey('x')), false);
  });
});

describe('PaneManager — Render', () => {
  it('render with docked, floating, and modal panes', () => {
    const pm = PaneManager.instance;
    pm.createPane(labelContent('docked'));
    pm.createFloating(labelContent('float'));
    pm.createModal(labelContent('modal'));
    pm.render();
    assert.ok(true);
  });
  it('render with no panes', () => {
    PaneManager.instance.render();
    assert.ok(true);
  });
  it('render after closeAll', () => {
    const pm = PaneManager.instance;
    pm.createPane(labelContent('t'));
    pm.closeAll();
    pm.render();
    assert.ok(true);
  });
});
