/**
 * Pane Manager — pane-based modal architecture with composable overlay stacking.
 *
 * Provides a full pane management system for the Babel TUI: docked panes in a
 * layout tree, floating panes with Z-ordering, modal overlays with dimmed
 * backdrops, keyboard routing, and terminal resize handling.
 *
 * Architecture:
 *   - PaneManager: singleton orchestrator managing panes, layout, Z-order, focus
 *   - Pane: individual pane with content render function, key handler, lifecycle
 *   - Docked panes: participate in the layout tree (splits, resizing)
 *   - Floating panes: rendered above docked panes, in Z-order (last = topmost)
 *   - Modals: floating panes that capture all keyboard events, with dimmed backdrop
 *
 * Integrates with OutputBuffer for DEC 2026 synchronized updates.
 *
 * @module paneManager
 */

import { OutputBuffer } from './outputBuffer.js';
import { LayoutEngine, type LayoutNode, type LayoutRegion, type Split } from './layout.js';
import type { KeyEvent } from './keyInput.js';
import { KeybindingManager } from './keybindings.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default minimum width for a pane. */
const DEFAULT_MIN_WIDTH = 20;

/** Default minimum height for a pane. */
const DEFAULT_MIN_HEIGHT = 3;

/** Dimmed backdrop ANSI escape: dim mode + default background. */
const DIM_BG = '\x1b[2m\x1b[48;5;236m';

/** Reset ANSI escape. */
const RESET = '\x1b[0m';

/** Maximum number of floating panes visible at once (safety limit). */
const MAX_FLOATING_PANES = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaneOptions {
  id?: string;
  title?: string;
  focusable?: boolean;
  modal?: boolean;
  floating?: boolean;
  width?: number | 'auto';
  height?: number | 'auto';
  minWidth?: number;
  minHeight?: number;
  closable?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onResize?: (region: LayoutRegion) => void;
}

// ─── Pane ─────────────────────────────────────────────────────────────────────

/**
 * A single pane in the pane system.  Has a content render function, optional
 * key handler, and lifecycle callbacks.
 *
 * Panes can be docked (in the layout tree), floating (above docked panes), or
 * modal (floating with a backdrop that captures all input).
 */
export class Pane {
  readonly id: string;
  readonly options: PaneOptions;
  region: LayoutRegion | null = null;
  content: (region: LayoutRegion) => string;
  handleKey?: (event: KeyEvent) => boolean;

  /** Z-order index (higher = on top). Only meaningful for floating panes. */
  zIndex: number = 0;

  /** Whether the pane is currently mounted and visible. */
  active: boolean = true;

  constructor(
    content: (region: LayoutRegion) => string,
    options: PaneOptions = {},
  ) {
    this.id = options.id ?? `pane-${nextPaneId()}`;
    this.options = options;
    this.content = content;
  }

  get focusable(): boolean {
    return this.options.focusable ?? true;
  }

  get modal(): boolean {
    return this.options.modal ?? false;
  }

  get floating(): boolean {
    return this.options.floating ?? false;
  }

  get closable(): boolean {
    return this.options.closable ?? true;
  }

  get title(): string {
    return this.options.title ?? '';
  }
}

let nextPaneIdCounter = 0;
function nextPaneId(): number {
  return ++nextPaneIdCounter;
}

// ─── PaneManager ──────────────────────────────────────────────────────────────

export class PaneManager {
  private static _instance: PaneManager | null = null;

  /** All managed panes, keyed by ID. */
  readonly panes: Map<string, Pane> = new Map();

  /** Docked pane IDs in layout order (matches DFS traversal of layout tree). */
  readonly dockedPaneIds: string[] = [];

  /** Floating pane IDs in Z-order (back to front). Last = topmost. */
  readonly floatingPaneIds: string[] = [];

  /** Z-order for all pane types — back to front. Last = topmost. */
  readonly zOrder: string[] = [];

  /** Currently focused pane ID, or null if no pane is focused. */
  focusedPaneId: string | null = null;

  /** The layout tree for docked panes. Null when no docked panes exist. */
  layoutTree: LayoutNode | null = null;

  /** Previously focused pane ID before a modal was opened. */
  private previousFocusId: string | null = null;

  /** Whether chord mode (Ctrl+P prefix) is active. */
  private chordActive: boolean = false;
  private chordTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether default keybindings are installed. */
  private keybindingsInstalled: boolean = false;

  // ── Singleton ──────────────────────────────────────────────

  static get instance(): PaneManager {
    if (!PaneManager._instance) {
      PaneManager._instance = new PaneManager();
    }
    return PaneManager._instance;
  }

  static resetInstance(): void {
    PaneManager._instance = null;
  }

  private constructor() {
    // Singleton — use PaneManager.instance
    this.installDefaultKeybindings();
  }

  // ── Pane Creation ────────────────────────────────────────────

  /**
   * Create a docked pane (participates in the layout tree).
   * If this is the first docked pane, the layout tree is created with it as
   * the sole leaf.  The pane is added to the end of the docked list.
   */
  createPane(
    content: Pane['content'],
    options: PaneOptions = {},
  ): Pane {
    const pane = new Pane(content, { ...options, floating: false, modal: false });
    this.panes.set(pane.id, pane);

    this.dockedPaneIds.push(pane.id);
    this.rebuildLayoutTree();

    // Focus the new pane if it's focusable and nothing else is focused
    if (pane.focusable && !this.focusedPaneId) {
      this.focusPane(pane.id);
    }

    return pane;
  }

  /**
   * Create a floating pane (rendered above docked panes, not in layout tree).
   */
  createFloating(
    content: Pane['content'],
    options: PaneOptions = {},
  ): Pane {
    const pane = new Pane(content, {
      ...options,
      floating: true,
      modal: false,
    });
    pane.zIndex = this.floatingPaneIds.length;
    this.panes.set(pane.id, pane);
    this.floatingPaneIds.push(pane.id);
    this.updateZOrder();

    if (pane.focusable && !this.focusedPaneId) {
      this.focusPane(pane.id);
    }

    return pane;
  }

  /**
   * Create a floating modal pane (centered, dimmed backdrop, captures all input).
   * The modal is created on top of all other panes.
   */
  createModal(
    content: Pane['content'],
    options: PaneOptions = {},
  ): Pane {
    const pane = new Pane(content, {
      ...options,
      floating: true,
      modal: true,
      focusable: true,
    });
    pane.zIndex = this.floatingPaneIds.length + 100; // always on top
    this.panes.set(pane.id, pane);
    this.floatingPaneIds.push(pane.id);
    this.updateZOrder();

    // Save previous focus
    this.previousFocusId = this.focusedPaneId;
    this.focusPane(pane.id);

    return pane;
  }

  /**
   * Push a modal on top of existing modals (stack modal on modal).
   * Each new modal gets Z = max(current) + 1, rendering above previous.
   */
  stackModal(
    content: Pane['content'],
    options: PaneOptions = {},
  ): Pane {
    // Find the highest Z among existing floating panes
    let maxZ = 0;
    for (const id of this.floatingPaneIds) {
      const p = this.panes.get(id);
      if (p && p.zIndex > maxZ) maxZ = p.zIndex;
    }

    const pane = new Pane(content, {
      ...options,
      floating: true,
      modal: true,
      focusable: true,
    });
    pane.zIndex = maxZ + 1;
    this.panes.set(pane.id, pane);
    this.floatingPaneIds.push(pane.id);
    this.updateZOrder();

    // Save previous focus (the current modal, not the original)
    this.previousFocusId = this.focusedPaneId;
    this.focusPane(pane.id);

    return pane;
  }

  // ── Split Operations ─────────────────────────────────────────

  /**
   * Split an existing pane horizontally (left/right) or vertically (top/bottom).
   * The existing pane becomes the first child, the new pane becomes the second.
   * Returns both panes.
   */
  splitPane(
    paneId: string,
    direction: 'horizontal' | 'vertical',
    newContent: Pane['content'],
    options: PaneOptions = {},
  ): { existing: Pane; new: Pane } {
    const existing = this.panes.get(paneId);
    if (!existing) {
      throw new Error(`Pane "${paneId}" not found`);
    }

    // Find the index of the existing pane in the docked list
    const idx = this.dockedPaneIds.indexOf(paneId);
    if (idx === -1) {
      throw new Error(`Pane "${paneId}" is not a docked pane`);
    }

    // Create the new pane
    const newPane = new Pane(newContent, options);
    newPane.region = null;
    this.panes.set(newPane.id, newPane);

    // Insert after the existing pane in docked order
    this.dockedPaneIds.splice(idx + 1, 0, newPane.id);

    // Update the layout tree: replace the leaf at index with a Split
    if (this.layoutTree) {
      const splitId = `split-${paneId}-${newPane.id}`;
      const split: Split = {
        type: direction,
        ratio: 0.5,
        first: { row: 1, col: 1, height: 1, width: 1 },
        second: { row: 1, col: 1, height: 1, width: 1 },
        id: splitId,
      };

      this.layoutTree = LayoutEngine.replaceLeaf(this.layoutTree, idx, split);
    }

    // Focus the new pane if it's focusable
    if (newPane.focusable) {
      this.focusPane(newPane.id);
    }

    return { existing, new: newPane };
  }

  // ── Pane Closure ────────────────────────────────────────────

  /**
   * Close a pane.  If it's the last docked pane, the layout tree becomes null.
   * For floating panes, they are removed from the floating list.
   * Modal dismissal returns focus to the previously focused pane.
   */
  closePane(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) return;

    // Call onClose lifecycle
    pane.options.onClose?.();

    const wasFocused = this.focusedPaneId === paneId;
    const wasModal = pane.modal;

    if (this.dockedPaneIds.includes(paneId)) {
      this.closeDockedPane(paneId);
    } else if (this.floatingPaneIds.includes(paneId)) {
      this.closeFloatingPane(paneId);
    }

    this.panes.delete(paneId);

    // Handle focus after closure
    if (wasFocused) {
      if (wasModal && this.previousFocusId) {
        // Return focus to the pane that was focused before the modal
        if (this.panes.has(this.previousFocusId)) {
          this.focusPane(this.previousFocusId);
        } else {
          this.focusNext();
        }
        this.previousFocusId = null;
      } else {
        this.focusNext();
      }
    }

    // Clean up chord state if no panes remain
    if (this.panes.size === 0) {
      this.clearChord();
    }
  }

  /**
   * Close all panes and reset state.
   */
  closeAll(): void {
    const allIds = [...this.panes.keys()];
    for (const id of allIds) {
      const pane = this.panes.get(id);
      if (pane) {
        pane.options.onClose?.();
      }
    }
    this.panes.clear();
    this.dockedPaneIds.length = 0;
    this.floatingPaneIds.length = 0;
    this.zOrder.length = 0;
    this.focusedPaneId = null;
    this.layoutTree = null;
    this.previousFocusId = null;
    this.clearChord();
  }

  // ── Focus Management ────────────────────────────────────────

  /**
   * Focus a specific pane.  Blurs the previously focused pane.
   */
  focusPane(paneId: string): void {
    if (this.focusedPaneId === paneId) return;

    const pane = this.panes.get(paneId);
    if (!pane || !pane.focusable || !pane.active) return;

    // Blur previous
    if (this.focusedPaneId) {
      const prev = this.panes.get(this.focusedPaneId);
      if (prev) {
        prev.options.onBlur?.();
      }
    }

    this.focusedPaneId = paneId;
    pane.options.onFocus?.();
  }

  /**
   * Focus the next focusable pane (Tab cycling).
   * Cycles through all active panes: docked first (in layout order), then
   * floating (in Z order).  Wraps around.
   */
  focusNext(): void {
    const focusable = this.getFocusablePaneIds();
    if (focusable.length === 0) {
      this.focusedPaneId = null;
      return;
    }

    if (!this.focusedPaneId) {
      this.focusPane(focusable[0]!);
      return;
    }

    const idx = focusable.indexOf(this.focusedPaneId);
    if (idx === -1 || idx + 1 >= focusable.length) {
      this.focusPane(focusable[0]!);
    } else {
      this.focusPane(focusable[idx + 1]!);
    }
  }

  /**
   * Focus the previous focusable pane (Shift+Tab cycling).
   */
  focusPrevious(): void {
    const focusable = this.getFocusablePaneIds();
    if (focusable.length === 0) {
      this.focusedPaneId = null;
      return;
    }

    if (!this.focusedPaneId) {
      this.focusPane(focusable[focusable.length - 1]!);
      return;
    }

    const idx = focusable.indexOf(this.focusedPaneId);
    if (idx <= 0) {
      this.focusPane(focusable[focusable.length - 1]!);
    } else {
      this.focusPane(focusable[idx - 1]!);
    }
  }

  // ── Key Handling ─────────────────────────────────────────────

  /**
   * Route a key event to the appropriate handler.
   *
   * Priority order:
   *   1. Chord mode (Ctrl+P prefix: pending second key)
   *   2. Floating panes in reverse Z-order (topmost first)
   *   3. Focused docked pane
   *
   * @returns true if the event was consumed
   */
  handleKey(event: KeyEvent): boolean {
    // Chord mode: waiting for second key after Ctrl+P
    if (this.chordActive) {
      return this.handleChord(event);
    }

    // Check for pane-specific global keybindings first
    const binding = KeybindingManager.getInstance().match('pane', event);

    // Gate pane chord prefix behind active panes to avoid conflict with
    // BabelRepl's Ctrl+P command palette shortcut when no panes are present.
    if (binding === 'prefix' && this.hasActivePanes()) {
      // Ctrl+P — enter chord mode
      this.activateChord();
      return true;
    }

    if (binding === 'close_pane') {
      // Ctrl+W — close focused pane
      if (this.focusedPaneId) {
        this.closePane(this.focusedPaneId);
      }
      return true;
    }

    if (binding === 'focus_next') {
      this.focusNext();
      return true;
    }

    if (binding === 'focus_prev') {
      this.focusPrevious();
      return true;
    }

    // Route to floating panes first (reverse Z-order = topmost first)
    for (let i = this.floatingPaneIds.length - 1; i >= 0; i--) {
      const id = this.floatingPaneIds[i]!;
      const pane = this.panes.get(id);
      if (pane && pane.active && pane.handleKey) {
        if (pane.handleKey(event)) return true;
      }
    }

    // Route to focused docked pane
    if (this.focusedPaneId) {
      const pane = this.panes.get(this.focusedPaneId);
      if (pane && pane.active && pane.handleKey) {
        if (pane.handleKey(event)) return true;
      }
    }

    return false;
  }

  // ── Rendering ────────────────────────────────────────────────

  /**
   * Render all visible panes to the OutputBuffer in Z-order.
   *
   * Rendering order:
   *   1. Docked panes (in layout order)
   *   2. Floating panes (in Z-order, back to front)
   *
   * Modal panes render a dimmed backdrop across the full terminal before
   * rendering their content centered.
   */
  render(): void {
    const size = OutputBuffer.getTerminalSize();
    const termRows = size.rows;
    const termCols = size.cols;

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      // 1. Render docked panes
      if (this.layoutTree && this.dockedPaneIds.length > 0) {
        const regions = LayoutEngine.compute(this.layoutTree, termRows, termCols);
        const regionIds = [...regions.keys()];

        for (let i = 0; i < this.dockedPaneIds.length && i < regionIds.length; i++) {
          const paneId = this.dockedPaneIds[i]!;
          const pane = this.panes.get(paneId);
          const region = regions.get(regionIds[i]!);

          if (pane && pane.active && region) {
            pane.region = region;
            this.renderPaneToBuffer(pane, region, buf, termCols);
          }
        }
      }

      // 2. Render floating panes in Z-order
      if (this.floatingPaneIds.length > 0) {
        // Sort by Z-index ascending (back to front)
        const sorted = [...this.floatingPaneIds]
          .map((id) => ({ id, pane: this.panes.get(id) }))
          .filter((e) => e.pane && e.pane.active)
          .sort((a, b) => a.pane!.zIndex - b.pane!.zIndex);

        for (const { id, pane } of sorted) {
          if (!pane) continue;

          // Modal pane: render dimmed backdrop first
          if (pane.modal) {
            this.renderModalBackdrop(buf, termRows, termCols);
          }

          // Compute floating pane region (centered if modal)
          const region = this.computeFloatingRegion(pane, termRows, termCols);
          pane.region = region;
          this.renderPaneToBuffer(pane, region, buf, termCols);
        }
      }
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  // ── Terminal Resize ─────────────────────────────────────────

  /**
   * Notify the PaneManager that the terminal has been resized.
   * Recomputes the layout and re-renders.
   */
  onTerminalResize(termRows: number, termCols: number): void {
    // Recompute regions for docked panes
    if (this.layoutTree && this.dockedPaneIds.length > 0) {
      const regions = LayoutEngine.compute(this.layoutTree, termRows, termCols);
      const regionIds = [...regions.keys()];

      for (let i = 0; i < this.dockedPaneIds.length && i < regionIds.length; i++) {
        const paneId = this.dockedPaneIds[i]!;
        const pane = this.panes.get(paneId);
        const region = regions.get(regionIds[i]!);

        if (pane && pane.active && region) {
          pane.region = region;
          pane.options.onResize?.(region);
        }
      }
    }

    // Recompute regions for floating panes
    for (const id of this.floatingPaneIds) {
      const pane = this.panes.get(id);
      if (pane && pane.active) {
        const region = this.computeFloatingRegion(pane, termRows, termCols);
        pane.region = region;
        pane.options.onResize?.(region);
      }
    }

    this.render();
  }

  // ── Keybinding Installation ─────────────────────────────────

  /**
   * Install default pane management keybindings into the KeybindingManager.
   *
   * Adds a 'pane' context with:
   *   prefix: Ctrl+P — chord prefix for pane operations
   *   close_pane: Ctrl+W — close focused pane
   *   focus_next: Tab — cycle focus forward
   *   focus_prev: Shift+Tab — cycle focus backward
   *
   * These are only intended to be active when multiple panes are open
   * (callers should gate on pane count).
   */
  installDefaultKeybindings(): void {
    if (this.keybindingsInstalled) return;
    this.keybindingsInstalled = true;

    // Eagerly initialize the KeybindingManager singleton so it loads
    // DEFAULT_BINDINGS (which includes the 'pane' context with Ctrl+P,
    // Ctrl+W, Tab, Shift+Tab, and split/resize chords).
    // The actual chord and binding matching is done in handleKey() above.
    KeybindingManager.getInstance();
  }

  // ── Helpers: Chord Mode ──────────────────────────────────────

  private activateChord(): void {
    this.chordActive = true;
    this.chordTimer = setTimeout(() => {
      this.clearChord();
    }, 1000); // 1-second chord timeout
  }

  private clearChord(): void {
    this.chordActive = false;
    if (this.chordTimer) {
      clearTimeout(this.chordTimer);
      this.chordTimer = null;
    }
  }

  /**
   * Handle the second key in a Ctrl+P chord.
   */
  private handleChord(event: KeyEvent): boolean {
    const key = event.name.toLowerCase();

    switch (key) {
      case 'v':
        // Vertical split (left/right)
        if (this.focusedPaneId) {
          this.splitPane(
            this.focusedPaneId,
            'horizontal',
            () => '',
            { title: 'New Pane' },
          );
          this.render();
        }
        break;

      case 's':
        // Horizontal split (top/bottom)
        if (this.focusedPaneId) {
          this.splitPane(
            this.focusedPaneId,
            'vertical',
            () => '',
            { title: 'New Pane' },
          );
          this.render();
        }
        break;

      case 'tab':
        // Cycle focus forward
        this.focusNext();
        this.render();
        break;

      case 'shift+tab':
        // Cycle focus backward
        this.focusPrevious();
        this.render();
        break;

      case '[':
        // Decrease split ratio
        this.adjustSplitRatio(-0.05);
        this.render();
        break;

      case ']':
        // Increase split ratio
        this.adjustSplitRatio(0.05);
        this.render();
        break;

      case 'left':
      case 'right':
      case 'up':
      case 'down':
        // Resize focused pane edge
        this.adjustSplitRatioByDirection(key as 'left' | 'right' | 'up' | 'down');
        this.render();
        break;

      default:
        // Unknown chord — clear and return false
        this.clearChord();
        return false;
    }

    this.clearChord();
    return true;
  }

  /**
   * Adjust the ratio of the split containing the focused pane.
   */
  private adjustSplitRatio(delta: number): void {
    if (!this.layoutTree || !this.focusedPaneId) return;

    // Find which split contains the focused pane
    const splitId = this.findSplitForPane(this.layoutTree, this.focusedPaneId);
    if (!splitId || !('id' in splitId)) return;

    // Apply resize
    if (LayoutEngine.isSplit(this.layoutTree)) {
      const result = LayoutEngine.resize(this.layoutTree as Split, (splitId as Split).id!, delta);
      if (LayoutEngine.isSplit(result)) {
        this.layoutTree = result;
      }
    }
  }

  /**
   * Adjust split ratio based on direction key relative to focused pane.
   * left/right affect horizontal splits, up/down affect vertical splits.
   */
  private adjustSplitRatioByDirection(dir: 'left' | 'right' | 'up' | 'down'): void {
    if (!this.layoutTree || !this.focusedPaneId) return;

    // Find the split containing the focused pane
    const splitInfo = this.findSplitForPane(this.layoutTree, this.focusedPaneId);
    if (!splitInfo) return;

    const split = splitInfo;
    if (LayoutEngine.isSplit(split)) {
      const s = split as Split;

      // Check if direction matches split type
      if ((dir === 'left' || dir === 'right') && s.type === 'horizontal') {
        const delta = dir === 'right' ? 0.05 : -0.05;
        const result = LayoutEngine.resize(s, s.id!, delta);
        if (LayoutEngine.isSplit(result)) {
          this.layoutTree = result;
        }
      } else if ((dir === 'up' || dir === 'down') && s.type === 'vertical') {
        const delta = dir === 'down' ? 0.05 : -0.05;
        const result = LayoutEngine.resize(s, s.id!, delta);
        if (LayoutEngine.isSplit(result)) {
          this.layoutTree = result;
        }
      }
    }
  }

  /**
   * Find the split node that contains the pane at the given leaf index.
   */
  private findSplitForPane(tree: LayoutNode, paneId: string): LayoutNode | null {
    const idx = this.dockedPaneIds.indexOf(paneId);
    if (idx === -1) return null;

    // Walk the tree to find the parent split of the leaf at index idx
    let currentIdx = 0;

    function walk(node: LayoutNode): LayoutNode | null {
      if (LayoutEngine.isSplit(node)) {
        const s = node as Split;

        // Count leaves in first child
        const firstCount = LayoutEngine.leafCount(s.first);

        if (currentIdx <= idx && idx < currentIdx + firstCount) {
          // The target is in the first child
          if (currentIdx === idx && LayoutEngine.isLeaf(s.first)) {
            // Direct child — this split is the parent
            return s;
          }
          currentIdx += firstCount; // Will be adjusted by recursion
          const savedIdx = currentIdx;
          currentIdx = currentIdx - firstCount; // Recurse into first
          const result = walk(s.first);
          if (result) return result;
          currentIdx = savedIdx;
        } else {
          currentIdx += firstCount;
          if (LayoutEngine.isLeaf(s.second)) {
            if (currentIdx === idx) return s;
            currentIdx++;
          } else {
            const result = walk(s.second);
            if (result) return result;
          }
        }
      } else {
        currentIdx++;
      }

      return null;
    }

    // Simpler approach: find the parent by traversing
    currentIdx = 0;
    return this.findSplitParent(tree, idx);
  }

  /**
   * Helper to find the parent split of the leaf at target index.
   */
  private findSplitParent(node: LayoutNode, targetIdx: number): LayoutNode | null {
    if (!LayoutEngine.isSplit(node)) return null;

    const s = node as Split;
    const firstLeaves = LayoutEngine.leafCount(s.first);

    if (targetIdx < firstLeaves) {
      // Target is in first child
      if (LayoutEngine.isLeaf(s.first) || firstLeaves === 1) {
        // Direct child leaf — this is the parent split
        if (LayoutEngine.isLeaf(s.first)) return s;
      }
      return this.findSplitParent(s.first, targetIdx);
    } else {
      // Target is in second child
      const secondIdx = targetIdx - firstLeaves;
      if (LayoutEngine.isLeaf(s.second)) {
        return s;
      }
      return this.findSplitParent(s.second, secondIdx);
    }
  }

  // ── Helpers: Rendering ───────────────────────────────────────

  /**
   * Render a single pane's content into the OutputBuffer at its region.
   */
  private renderPaneToBuffer(
    pane: Pane,
    region: LayoutRegion,
    buf: OutputBuffer,
    termCols: number,
  ): void {
    if (!pane.active) return;

    const contentStr = pane.content(region);
    const lines = contentStr.split('\n');

    const maxLines = Math.min(lines.length, region.height);
    const maxWidth = region.width;

    for (let i = 0; i < maxLines; i++) {
      const rawLine = lines[i] ?? '';
      const truncated = rawLine.length > maxWidth
        ? rawLine.slice(0, Math.max(0, maxWidth - 1)) + '…'
        : rawLine;
      const padded = truncated + ' '.repeat(Math.max(0, maxWidth - truncated.length));
      buf.writeLine(region.row + i, region.col, padded);
    }

    // Clear any remaining lines in the region
    for (let i = maxLines; i < region.height; i++) {
      buf.writeLine(region.row + i, region.col, ' '.repeat(maxWidth));
    }
  }

  /**
   * Render a dimmed backdrop across the entire terminal for modal panes.
   */
  private renderModalBackdrop(
    buf: OutputBuffer,
    termRows: number,
    termCols: number,
  ): void {
    for (let r = 1; r <= termRows; r++) {
      buf.writeLine(r, 1, DIM_BG + ' '.repeat(termCols) + RESET);
    }
  }

  /**
   * Compute the region for a floating pane (centered if modal, otherwise
   * auto-sized).
   */
  private computeFloatingRegion(
    pane: Pane,
    termRows: number,
    termCols: number,
  ): LayoutRegion {
    if (pane.modal) {
      // Centered modal
      const width = typeof pane.options.width === 'number'
        ? pane.options.width
        : Math.min(70, Math.floor(termCols * 0.8));
      const height = typeof pane.options.height === 'number'
        ? pane.options.height
        : Math.min(20, Math.floor(termRows * 0.6));

      const minW = pane.options.minWidth ?? DEFAULT_MIN_WIDTH;
      const minH = pane.options.minHeight ?? DEFAULT_MIN_HEIGHT;
      const finalW = Math.max(minW, Math.min(width, termCols - 2));
      const finalH = Math.max(minH, Math.min(height, termRows - 2));

      const col = Math.max(1, Math.floor((termCols - finalW) / 2));
      const row = Math.max(1, Math.floor((termRows - finalH) / 2));

      return { row, col, height: finalH, width: finalW };
    }

    // Non-modal floating — default to a reasonable default region
    const width = Math.min(60, Math.floor(termCols * 0.6));
    const height = Math.min(15, Math.floor(termRows * 0.4));
    const col = Math.max(1, Math.floor((termCols - width) / 2));
    const row = Math.max(1, Math.floor((termRows - height) / 2));

    return { row, col, height, width };
  }

  // ── Helpers: Z-order and Layout ─────────────────────────────

  /** Rebuild the zOrder array from docked + floating panes. */
  private updateZOrder(): void {
    this.zOrder.length = 0;
    this.zOrder.push(...this.dockedPaneIds);

    // Floating panes sorted by Z-index
    const sortedFloating = [...this.floatingPaneIds].sort((a, b) => {
      const pa = this.panes.get(a);
      const pb = this.panes.get(b);
      return (pa?.zIndex ?? 0) - (pb?.zIndex ?? 0);
    });
    this.zOrder.push(...sortedFloating);
  }

  /**
   * Rebuild the layout tree from the current docked pane list.
   * If there's only one pane, the tree is just a leaf region.
   * If there are multiple panes, the existing split tree is preserved
   * (panes are already in the tree from split operations).
   */
  private rebuildLayoutTree(): void {
    if (this.dockedPaneIds.length === 0) {
      this.layoutTree = null;
      return;
    }

    if (this.dockedPaneIds.length === 1) {
      this.layoutTree = { row: 1, col: 1, height: 1, width: 1 };
      return;
    }

    // For multiple panes, the tree should already exist from split operations.
    // If it doesn't, we create a default vertical split.
    if (!this.layoutTree) {
      // Create evenly-spaced vertical splits for all panes
      let currentTree: LayoutNode = { row: 1, col: 1, height: 1, width: 1 };
      for (let i = 1; i < this.dockedPaneIds.length; i++) {
        const ratio = 1 / (this.dockedPaneIds.length - i + 1);
        currentTree = {
          type: 'vertical',
          ratio,
          first: currentTree,
          second: { row: 1, col: 1, height: 1, width: 1 },
          id: `split-auto-${i}`,
        };
      }
      this.layoutTree = currentTree;
    }
  }

  /** Close a docked pane and update the layout tree. */
  private closeDockedPane(paneId: string): void {
    const idx = this.dockedPaneIds.indexOf(paneId);
    if (idx === -1) return;

    this.dockedPaneIds.splice(idx, 1);

    // Remove the pane from the layout tree
    if (this.layoutTree) {
      if (LayoutEngine.leafCount(this.layoutTree) <= 1) {
        this.layoutTree = null;
      } else if (this.dockedPaneIds.length === 1) {
        // Only one pane left — reset to single leaf
        this.layoutTree = { row: 1, col: 1, height: 1, width: 1 };
      } else {
        // Remove the leaf by replacing the parent split with the other child
        this.removeLeafFromTree(idx);
      }
    }
  }

  /**
   * Remove a leaf at the given index from the layout tree.
   * When removing, the parent split is replaced by the sibling branch.
   */
  private removeLeafFromTree(targetIdx: number): void {
    if (!this.layoutTree) return;

    function removeLeaf(node: LayoutNode, idx: number, currentIdx: { value: number }): LayoutNode | null {
      if (LayoutEngine.isSplit(node)) {
        const s = node as Split;
        const firstLeaves = LayoutEngine.leafCount(s.first);

        if (idx < currentIdx.value + firstLeaves) {
          // Target is in first child
          if (LayoutEngine.isLeaf(s.first) && currentIdx.value === idx) {
            // The first child is the target leaf — replace with second child
            currentIdx.value++;
            return s.second;
          }
          const newFirst = removeLeaf(s.first, idx, currentIdx);
          if (newFirst === null) {
            // First child became empty — return second child
            currentIdx.value += LayoutEngine.leafCount(s.second);
            return s.second;
          }
          return { ...s, first: newFirst } as Split;
        } else {
          currentIdx.value += firstLeaves;

          if (LayoutEngine.isLeaf(s.second) && currentIdx.value === idx) {
            // The second child is the target leaf — return first child
            currentIdx.value++;
            return s.first;
          }
          const newSecond = removeLeaf(s.second, idx, currentIdx);
          if (newSecond === null) {
            return s.first;
          }
          return { ...s, second: newSecond } as Split;
        }
      } else {
        // Leaf
        if (currentIdx.value === idx) {
          currentIdx.value++;
          return null; // Remove this leaf
        }
        currentIdx.value++;
        return node;
      }
    }

    this.layoutTree = removeLeaf(this.layoutTree, targetIdx, { value: 0 });
  }

  /** Close a floating pane. */
  private closeFloatingPane(paneId: string): void {
    const idx = this.floatingPaneIds.indexOf(paneId);
    if (idx >= 0) {
      this.floatingPaneIds.splice(idx, 1);
    }
    this.updateZOrder();
  }

  /**
   * Get all focusable pane IDs (docked first, then floating in Z-order).
   */
  private getFocusablePaneIds(): string[] {
    const ids: string[] = [];

    // Docked panes in layout order
    for (const id of this.dockedPaneIds) {
      const pane = this.panes.get(id);
      if (pane && pane.focusable && pane.active) {
        ids.push(id);
      }
    }

    // Floating panes in Z-order (back to front)
    const sortedFloating = [...this.floatingPaneIds]
      .filter((id) => {
        const pane = this.panes.get(id);
        return pane && pane.focusable && pane.active;
      })
      .sort((a, b) => {
        const pa = this.panes.get(a);
        const pb = this.panes.get(b);
        return (pa?.zIndex ?? 0) - (pb?.zIndex ?? 0);
      });
    ids.push(...sortedFloating);

    return ids;
  }

  /**
   * Check whether any panes are actively managed.
   * Returns true when there are multiple docked panes (split layout) or any
   * floating/modal panes. Used to gate pane-only keybindings like Ctrl+P
   * so they fall through to other handlers when no panes are active.
   */
  private hasActivePanes(): boolean {
    return this.dockedPaneIds.length > 1 || this.floatingPaneIds.length > 0;
  }
}
