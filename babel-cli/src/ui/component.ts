/**
 * Component — lightweight TUI widget base class for Babel.
 *
 * Principals: no virtual DOM (string output), dirty tracking, composition,
 * single-focus owner, mount/unmount lifecycle.  Modelled on Ratatui's Widget
 * trait, not React/Ink.
 *
 * Subclasses MUST implement {@link render} and {@link handleKey}.
 * External callers should use {@link renderSafe} instead of calling
 * `render()` directly — it wraps the render call in an error boundary
 * and returns a fallback string on failure.
 *
 * @module component
 */

import type { KeyEvent } from './keyInput.js';
import { getEffectiveTerminalWidth } from './theme.js';

// ─── Module-level state ───────────────────────────────────────────────────────

let nextComponentId = 0;

/** The single currently-focused component, or `null` if none are focused. */
let focusedComponent: Component | null = null;

// ─── Component base class ────────────────────────────────────────────────────

export abstract class Component {
  // ── Public properties ─────────────────────────────────────────────────────

  /** Unique identifier (e.g. `comp_1`, `comp_2`). */
  readonly id: string;

  /** Parent component. `null` for the tree root. */
  parent: Component | null = null;

  /** Child components in insertion order. */
  readonly children: Component[] = [];

  /** Whether this component needs re-render. Starts `true`. */
  dirty = true;

  /** Whether this component currently holds focus. Set via `focus()`/`blur()`. */
  focused = false;

  /** Whether this component is mounted in the live tree. */
  mounted = false;

  /** Set when render() or a lifecycle hook throws. Null means no current error. */
  protected _renderError: Error | null = null;

  /** Get the current render error, if any. */
  get renderError(): Error | null {
    return this._renderError;
  }

  constructor() {
    this.id = `comp_${++nextComponentId}`;
  }

  // ── Abstract methods (subclasses MUST implement) ──────────────────────────

  /** Render to a string (may include ANSI escape sequences). */
  abstract render(): string;

  /**
   * Handle a key event.
   * @returns `true` if the event was consumed.
   */
  abstract handleKey(event: KeyEvent): boolean;

  // ── Optional lifecycle hooks ──────────────────────────────────────────────

  /** Called when the component is mounted (added to the live tree). */
  onMount(): void {
    /* optional */
  }

  /** Called when the component is unmounted (removed from the live tree). */
  onUnmount(): void {
    /* optional */
  }

  /** Called on terminal resize. */
  onResize(_cols: number, _rows: number): void {
    /* optional */
  }

  // ── Error boundary ─────────────────────────────────────────────────────

  /**
   * Reset error state after recovery.
   * Marks the component dirty so it re-renders on the next frame.
   */
  clearError(): void {
    if (this._renderError !== null) {
      this._renderError = null;
      this.dirty = true;
    }
  }

  /**
   * Fallback rendering when render() throws.
   * Subclasses may override for custom error display.
   */
  protected fallbackRender(): string {
    const name = this.constructor.name;
    return `\x1b[2m[${name} render error]\x1b[22m`; // dimmed placeholder
  }

  /**
   * Render with error boundary.
   * Returns fallback string on failure instead of throwing.
   */
  renderSafe(): string {
    try {
      this._renderError = null;
      const output = this.render();
      this.dirty = false;
      return output;
    } catch (err) {
      this._renderError = err instanceof Error ? err : new Error(String(err));
      this.dirty = false; // prevent infinite re-render loops
      return this.fallbackRender();
    }
  }

  // ── Composition ───────────────────────────────────────────────────────────

  /**
   * Add a child.  Removes it from its previous parent first.  If this
   * component is mounted the child is mounted immediately.
   */
  addChild(child: Component): void {
    if (child.parent) {
      child.parent.removeChild(child);
    }
    child.parent = this;
    this.children.push(child);
    if (this.mounted) {
      child.mountRecursive();
    }
  }

  /** Remove a child.  Unmounts it if currently mounted. */
  removeChild(child: Component): void {
    const idx = this.children.indexOf(child);
    if (idx === -1) return;
    this.children.splice(idx, 1);
    child.parent = null;
    if (child.mounted) {
      child.unmountRecursive();
    }
  }

  /** Find a component by ID (depth-first pre-order). */
  findById(id: string): Component | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.findById(id);
      if (found) return found;
    }
    return null;
  }

  // ── Dirty tracking ────────────────────────────────────────────────────────

  /**
   * Mark this component as dirty.
   * @param propagateUp  When `true`, also mark all ancestors dirty.
   */
  markDirty(propagateUp?: boolean): void {
    this.dirty = true;
    if (propagateUp && this.parent) {
      this.parent.markDirty(true);
    }
  }

  /** Mark this component and every descendant as dirty. */
  markDirtyTree(): void {
    this.dirty = true;
    for (const child of this.children) {
      child.markDirtyTree();
    }
  }

  // ── Focus management ──────────────────────────────────────────────────────

  /** Focus this component, blurring the previously focused component. */
  focus(): void {
    if (focusedComponent && focusedComponent !== this) {
      focusedComponent.blur();
    }
    this.focused = true;
    focusedComponent = this;
  }

  /** Remove focus from this component. */
  blur(): void {
    this.focused = false;
    if (focusedComponent === this) {
      focusedComponent = null;
    }
  }

  /**
   * Move focus to the next focusable component in depth-first tree order,
   * wrapping around to the first when the last is reached.
   */
  focusNext(): void {
    const all = this.rootFocusableDescendants();
    if (all.length === 0) return;

    if (!focusedComponent) {
      all[0]!.focus();
      return;
    }

    const idx = all.indexOf(focusedComponent as Component);
    if (idx === -1 || idx + 1 >= all.length) {
      all[0]!.focus();
    } else {
      all[idx + 1]!.focus();
    }
  }

  /**
   * Move focus to the previous focusable component in depth-first tree order,
   * wrapping around to the last when the first is reached.
   */
  focusPrevious(): void {
    const all = this.rootFocusableDescendants();
    if (all.length === 0) return;

    if (!focusedComponent) {
      all[all.length - 1]!.focus();
      return;
    }

    const idx = all.indexOf(focusedComponent as Component);
    if (idx === -1 || idx - 1 < 0) {
      all[all.length - 1]!.focus();
    } else {
      all[idx - 1]!.focus();
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /** Safe terminal width available for rendering. */
  protected getAvailableWidth(): number {
    return getEffectiveTerminalWidth();
  }

  /**
   * Override to exclude this component from focus traversal. Defaults to
   * `true` (focusable).
   */
  protected canFocus(): boolean {
    return true;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Mount this component and all descendants. */
  public mountRecursive(): void {
    this.mounted = true;
    this.onMount();
    for (const child of this.children) {
      child.mountRecursive();
    }
  }

  /** Unmount this component and all descendants. Blurs first if focused. */
  public unmountRecursive(): void {
    this.blur();
    this.mounted = false;
    this.onUnmount();
    for (const child of this.children) {
      child.unmountRecursive();
    }
  }

  /** Walk up to the tree root. */
  private getRoot(): Component {
    let node: Component = this;
    while (node.parent) {
      node = node.parent as Component;
    }
    return node;
  }

  /** Collect all focusable components from root in depth-first pre-order. */
  private rootFocusableDescendants(): Component[] {
    const result: Component[] = [];
    const stack: Component[] = [this.getRoot()];

    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.canFocus()) {
        result.push(node);
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]!);
      }
    }

    return result;
  }
}
