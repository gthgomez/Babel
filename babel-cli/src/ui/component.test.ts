/**
 * component.test.ts — Component base class lifecycle and composition tests.
 *
 * Tests constructor defaults, mount/unmount lifecycle, parent-child
 * composition, dirty tracking, and focus management. Error-boundary
 * behavior is tested separately in component-error-boundary.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Component } from './component.js';
import type { KeyEvent } from './keyInput.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

class TestComponent extends Component {
  public mountCount = 0;
  public unmountCount = 0;
  public resizeCols = 0;
  public resizeRows = 0;

  render(): string {
    return `[${this.id}]`;
  }
  handleKey(_event: KeyEvent): boolean {
    return false;
  }

  override onMount(): void {
    this.mountCount++;
  }
  override onUnmount(): void {
    this.unmountCount++;
  }
  override onResize(cols: number, rows: number): void {
    this.resizeCols = cols;
    this.resizeRows = rows;
  }
}

class FocusableComponent extends Component {
  render(): string {
    return `[${this.id}]`;
  }
  handleKey(_event: KeyEvent): boolean {
    return false;
  }
}

class NonFocusableComponent extends Component {
  render(): string {
    return `[${this.id}]`;
  }
  handleKey(_event: KeyEvent): boolean {
    return false;
  }
  protected override canFocus(): boolean {
    return false;
  }
}

/** Ensure the module-level focusedComponent is null before/after focus tests. */
function blurAll(...comps: Component[]): void {
  for (const c of comps) c.blur();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Constructor defaults
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component constructor', () => {
  it('initializes with dirty=true, mounted=false, focused=false', () => {
    const c = new TestComponent();
    assert.equal(c.dirty, true);
    assert.equal(c.mounted, false);
    assert.equal(c.focused, false);
    assert.equal(c.parent, null);
    assert.deepEqual(c.children, []);
    assert.equal(c.renderError, null);
  });

  it('generates unique sequential ids (comp_N pattern)', () => {
    const a = new TestComponent();
    const b = new TestComponent();
    assert.match(a.id, /^comp_\d+$/);
    assert.match(b.id, /^comp_\d+$/);
    assert.notEqual(a.id, b.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Lifecycle: mount / unmount
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component mount/unmount lifecycle', () => {
  it('mountRecursive() sets mounted=true and calls onMount()', () => {
    const c = new TestComponent();
    assert.equal(c.mounted, false);
    assert.equal(c.mountCount, 0);
    c.mountRecursive();
    assert.equal(c.mounted, true);
    assert.equal(c.mountCount, 1);
  });

  it('unmountRecursive() sets mounted=false, calls onUnmount(), blurs', () => {
    const c = new TestComponent();
    c.mountRecursive();
    c.focus();
    assert.equal(c.focused, true);
    c.unmountRecursive();
    assert.equal(c.mounted, false);
    assert.equal(c.unmountCount, 1);
    assert.equal(c.focused, false);
  });

  it('double-mount increments mountCount on each call (no implicit guard)', () => {
    const c = new TestComponent();
    c.mountRecursive();
    c.mountRecursive(); // second call — no guard in implementation
    assert.equal(c.mountCount, 2);
    assert.equal(c.mounted, true);
  });

  it('double-unmount increments unmountCount on each call (no implicit guard)', () => {
    const c = new TestComponent();
    c.mountRecursive();
    c.unmountRecursive();
    c.unmountRecursive(); // second call — no guard in implementation
    assert.equal(c.unmountCount, 2);
    assert.equal(c.mounted, false);
  });

  it('onResize is called via onResize()', () => {
    const c = new TestComponent();
    c.onResize(120, 40);
    assert.equal(c.resizeCols, 120);
    assert.equal(c.resizeRows, 40);
  });

  it('getAvailableWidth() returns a positive integer', () => {
    const c = new TestComponent();
    const w = (c as any).getAvailableWidth();
    assert.ok(typeof w === 'number');
    assert.ok(w >= 40);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Composition: addChild / removeChild / findById
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component composition', () => {
  it('addChild sets parent and appends to children', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);
    assert.equal(child.parent, parent);
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0], child);
  });

  it('addChild mounts child when parent is already mounted', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.mountRecursive();
    parent.addChild(child);
    assert.equal(child.mounted, true);
    assert.equal(child.mountCount, 1);
  });

  it('addChild does NOT mount child when parent is not mounted', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);
    assert.equal(child.mounted, false);
    assert.equal(child.mountCount, 0);
  });

  it('removeChild removes from children and sets parent=null', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);
    parent.removeChild(child);
    assert.equal(child.parent, null);
    assert.equal(parent.children.length, 0);
  });

  it('removeChild unmounts child when mounted', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);
    parent.mountRecursive(); // mounts both
    assert.equal(child.mounted, true);
    parent.removeChild(child);
    assert.equal(child.mounted, false);
    assert.equal(child.unmountCount, 1);
  });

  it('removeChild on non-child is a no-op', () => {
    const parent = new TestComponent();
    const unrelated = new TestComponent();
    assert.doesNotThrow(() => parent.removeChild(unrelated));
  });

  it('addChild removes from previous parent first (re-parenting)', () => {
    const p1 = new TestComponent();
    const p2 = new TestComponent();
    const child = new TestComponent();
    p1.addChild(child);
    assert.equal(p1.children.length, 1);
    p2.addChild(child);
    assert.equal(p1.children.length, 0, 'removed from first parent');
    assert.equal(child.parent, p2);
    assert.equal(p2.children.length, 1);
  });

  it('findById() finds direct match on self', () => {
    const c = new TestComponent();
    assert.equal(c.findById(c.id), c);
  });

  it('findById() finds nested child', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);
    assert.equal(parent.findById(child.id), child);
  });

  it('findById() returns null for non-existent id', () => {
    const c = new TestComponent();
    assert.equal(c.findById('nonexistent'), null);
  });

  it('findById() searches depth-first', () => {
    const root = new TestComponent();
    const mid = new TestComponent();
    const leaf = new TestComponent();
    root.addChild(mid);
    mid.addChild(leaf);
    assert.equal(root.findById(leaf.id), leaf);
    assert.equal(root.findById(mid.id), mid);
  });

  it('children mount/unmount with parent via mountRecursive/unmountRecursive', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);

    parent.mountRecursive();
    assert.equal(child.mounted, true);
    assert.equal(child.mountCount, 1);

    parent.unmountRecursive();
    assert.equal(child.mounted, false);
    assert.equal(child.unmountCount, 1);
    assert.equal(parent.mounted, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Dirty tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component dirty tracking', () => {
  it('markDirty() sets dirty flag on self', () => {
    const c = new TestComponent();
    c.dirty = false;
    c.markDirty();
    assert.equal(c.dirty, true);
  });

  it('markDirty(true) propagates to parent', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    parent.addChild(child);
    parent.dirty = false;
    child.dirty = false;
    child.markDirty(true);
    assert.equal(child.dirty, true);
    assert.equal(parent.dirty, true);
  });

  it('markDirty(true) does NOT propagate when there is no parent', () => {
    const c = new TestComponent();
    c.dirty = false;
    c.markDirty(true);
    assert.equal(c.dirty, true);
  });

  it('markDirtyTree() marks self and all descendants', () => {
    const parent = new TestComponent();
    const child = new TestComponent();
    const grandchild = new TestComponent();
    parent.addChild(child);
    child.addChild(grandchild);
    parent.dirty = false;
    child.dirty = false;
    grandchild.dirty = false;
    parent.markDirtyTree();
    assert.equal(parent.dirty, true);
    assert.equal(child.dirty, true);
    assert.equal(grandchild.dirty, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Focus management
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component focus management', () => {
  it('focus() sets focused=true on the component', () => {
    const c = new FocusableComponent();
    c.focus();
    assert.equal(c.focused, true);
    c.blur(); // cleanup
  });

  it('focus() blurs previously focused component', () => {
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    a.focus();
    assert.equal(a.focused, true);
    b.focus();
    assert.equal(a.focused, false);
    assert.equal(b.focused, true);
    b.blur(); // cleanup
  });

  it('blur() removes focus from self', () => {
    const c = new FocusableComponent();
    c.focus();
    assert.equal(c.focused, true);
    c.blur();
    assert.equal(c.focused, false);
  });

  it('blur() on non-focused component is a no-op', () => {
    const c = new FocusableComponent();
    assert.doesNotThrow(() => c.blur());
    assert.equal(c.focused, false);
  });

  it('focusNext() focuses first focusable child when nothing is focused', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    root.addChild(a);
    root.addChild(b);
    root.focusNext();
    assert.equal(root.focused, false);
    assert.equal(a.focused, true);
    assert.equal(b.focused, false);
    blurAll(a);
  });

  it('focusNext() cycles forward through focusable children', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    root.addChild(a);
    root.addChild(b);
    a.focus();
    root.focusNext();
    assert.equal(a.focused, false);
    assert.equal(b.focused, true);
    blurAll(b);
  });

  it('focusNext() wraps to first when last is focused', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    root.addChild(a);
    root.addChild(b);
    b.focus();
    root.focusNext();
    assert.equal(b.focused, false);
    assert.equal(a.focused, true);
    blurAll(a);
  });

  it('focusNext() skips non-focusable components', () => {
    const root = new NonFocusableComponent();
    const focusable = new FocusableComponent();
    const nonFocusable = new NonFocusableComponent();
    root.addChild(focusable);
    root.addChild(nonFocusable);
    focusable.focus();
    root.focusNext();
    // Only one focusable — wraps around to itself
    assert.equal(focusable.focused, true);
    blurAll(focusable);
  });

  it('focusNext() is a no-op when no components are focusable', () => {
    const root = new NonFocusableComponent();
    const a = new NonFocusableComponent();
    root.addChild(a);
    assert.doesNotThrow(() => root.focusNext());
  });

  it('focusPrevious() cycles backward through focusable children', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    root.addChild(a);
    root.addChild(b);
    a.focus();
    root.focusPrevious();
    assert.equal(a.focused, false);
    assert.equal(b.focused, true);
    blurAll(b);
  });

  it('focusPrevious() wraps to last when first is focused', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    root.addChild(a);
    root.addChild(b);
    a.focus();
    root.focusPrevious();
    assert.equal(b.focused, true);
    blurAll(b);
  });

  it('focusPrevious() focuses last when nothing is focused', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new FocusableComponent();
    root.addChild(a);
    root.addChild(b);
    root.focusPrevious();
    assert.equal(b.focused, true);
    blurAll(b);
  });

  it('focusPrevious() skips non-focusable components', () => {
    const root = new NonFocusableComponent();
    const a = new FocusableComponent();
    const b = new NonFocusableComponent();
    root.addChild(a);
    root.addChild(b);
    a.focus();
    root.focusPrevious();
    // Only one focusable, wraps to itself
    assert.equal(a.focused, true);
    blurAll(a);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. renderSafe (supplement — basic sanity beyond error-boundary tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Component renderSafe()', () => {
  it('returns normal rendering and clears dirty flag', () => {
    const c = new TestComponent();
    c.dirty = true;
    const result = c.renderSafe();
    assert.ok(result.includes(c.id));
    assert.equal(c.dirty, false);
    assert.equal(c.renderError, null);
  });

  it('returns fallback on error and clears dirty flag', () => {
    class BrokenComponent extends Component {
      render(): string {
        throw new Error('boom');
      }
      handleKey(_event: KeyEvent): boolean {
        return false;
      }
    }
    const c = new BrokenComponent();
    c.dirty = true;
    const result = c.renderSafe();
    assert.ok(result.includes('BrokenComponent'));
    assert.equal(c.dirty, false);
    assert.equal(c.renderError?.message, 'boom');
  });
});
