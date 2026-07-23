/**
 * Layout Engine for Babel's TUI.
 *
 * Provides a recursive partitioning layout system with horizontal and vertical
 * splits.  Layout trees are pure data structures — the compute() function
 * produces a flat Map of region IDs to absolute LayoutRegions by traversing
 * the tree top-down and partitioning the terminal space.
 *
 * Architecture:
 *   - LayoutRegion: absolute screen region (1-based row/col)
 *   - Split: internal tree node that divides its space between two children
 *   - LayoutNode: either a leaf (LayoutRegion) or a Split
 *   - LayoutEngine: pure static functions for compute, regionAt, resize
 *
 * Region IDs are generated in DFS order: "pane-1", "pane-2", etc.
 *
 * @module layout
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

/** An absolute screen region with 1-based row/col coordinates. */
export interface LayoutRegion {
  row: number;
  col: number;
  height: number;
  width: number;
}

/** A tree node that divides space into two children. */
export interface Split {
  type: 'horizontal' | 'vertical';
  /** Fraction (0..1) of the parent's dimension given to the first child. */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
  /** Optional identifier for resize targeting. */
  id?: string;
}

/** A node in the layout tree: either a leaf region or a split. */
export type LayoutNode = LayoutRegion | Split;

// ─── Internal ID generator ────────────────────────────────────────────────────

let nextLeafId = 0;

function resetLeafId(): void {
  nextLeafId = 0;
}

function nextRegionId(): string {
  return `pane-${++nextLeafId}`;
}

// ─── LayoutEngine ─────────────────────────────────────────────────────────────

export class LayoutEngine {
  /**
   * Compute absolute LayoutRegions from a layout tree and terminal dimensions.
   *
   * Traverses the tree in DFS pre-order (first before second).  Each leaf gets
   * an auto-generated regionId ("pane-1", "pane-2", …) that corresponds to its
   * traversal position.
   *
   * @param root - The layout tree root
   * @param termRows - Terminal row count
   * @param termCols - Terminal column count
   * @returns Flat Map of regionId -> LayoutRegion
   */
  static compute(
    root: LayoutNode,
    termRows: number,
    termCols: number,
  ): Map<string, LayoutRegion> {
    resetLeafId();
    const regions = new Map<string, LayoutRegion>();
    LayoutEngine._computeNode(root, 1, 1, termRows, termCols, regions);
    return regions;
  }

  /**
   * Find which region a given screen position (row, col) falls in.
   * Returns the region ID or null if no region contains the position.
   */
  static regionAt(
    regions: Map<string, LayoutRegion>,
    row: number,
    col: number,
  ): string | null {
    for (const [id, region] of regions) {
      if (
        row >= region.row &&
        row < region.row + region.height &&
        col >= region.col &&
        col < region.col + region.width
      ) {
        return id;
      }
    }
    return null;
  }

  /**
   * Resize a split — increase first child's ratio by delta.
   * Clamps ratio to [0.1, 0.9].  Returns a new root with the
   * modified ratio if the split was found, or the original root.
   */
  static resize(root: Split, splitId: string, delta: number): LayoutNode {
    const [newRoot, changed] = LayoutEngine._resizeNode(root, splitId, delta);
    return changed ? newRoot : root;
  }

  /**
   * Check whether a LayoutNode is a Split (has a `type` property).
   */
  static isSplit(node: LayoutNode): node is Split {
    return 'type' in node;
  }

  /**
   * Check whether a LayoutNode is a leaf region.
   */
  static isLeaf(node: LayoutNode): node is LayoutRegion {
    return !LayoutEngine.isSplit(node);
  }

  /**
   * Count the number of leaf regions in a layout tree (DFS traversal).
   */
  static leafCount(node: LayoutNode): number {
    if (LayoutEngine.isSplit(node)) {
      const s = node as Split;
      return LayoutEngine.leafCount(s.first) + LayoutEngine.leafCount(s.second);
    }
    return 1;
  }

  /**
   * Walk a layout tree DFS, calling visit(node) for each node.  Returns a
   * new tree where each node is replaced by the return value of visit
   * (identity by default).  Used by PaneManager to map pane IDs to leaves.
   *
   * @param root - The tree root
   * @param visit - Visitor called for each leaf (returns replacement leaf)
   * @returns A new tree with leaves replaced
   */
  static mapLeaves(
    root: LayoutNode,
    visit: (leaf: LayoutRegion, index: number) => LayoutRegion,
  ): LayoutNode {
    let idx = 0;

    function walk(node: LayoutNode): LayoutNode {
      if (LayoutEngine.isSplit(node)) {
        const s = node as Split;
        return {
          ...s,
          first: walk(s.first),
          second: walk(s.second),
        } as Split;
      }
      const leaf = node as LayoutRegion;
      return visit(leaf, idx++);
    }

    return walk(root);
  }

  /**
   * Walk the tree and find a leaf by index (DFS order).
   * Returns the leaf node, its parent split (if any), and whether it's the
   * first child.  Used by PaneManager for split and close operations.
   */
  static findLeafByIndex(
    node: LayoutNode,
    targetIdx: number,
  ): {
    leaf: LayoutRegion;
    parent: Split | null;
    isFirst: boolean;
    index: number;
  } | null {
    let currentIdx = 0;

    function search(
      n: LayoutNode,
      parent: Split | null,
      isFirst: boolean,
    ): {
      leaf: LayoutRegion;
      parent: Split | null;
      isFirst: boolean;
      index: number;
    } | null {
      if (LayoutEngine.isSplit(n)) {
        const s = n as Split;
        const firstResult = search(s.first, s, true);
        if (firstResult) return firstResult;
        return search(s.second, s, false);
      }

      const leaf = n as LayoutRegion;
      const thisIdx = currentIdx++;
      if (thisIdx === targetIdx) {
        return { leaf, parent, isFirst, index: thisIdx };
      }
      return null;
    }

    return search(node, null, true);
  }

  /**
   * Replace a leaf at the given index in the tree.
   * Returns a new tree with the leaf replaced.
   */
  static replaceLeaf(
    root: LayoutNode,
    targetIdx: number,
    replacement: LayoutNode,
  ): LayoutNode {
    let currentIdx = 0;

    function walk(node: LayoutNode): LayoutNode {
      if (LayoutEngine.isSplit(node)) {
        const s = node as Split;
        return {
          ...s,
          first: walk(s.first),
          second: walk(s.second),
        } as Split;
      }

      if (currentIdx++ === targetIdx) {
        return replacement;
      }
      return node;
    }

    return walk(root);
  }

  // ── Private ─────────────────────────────────────────────────

  private static _computeNode(
    node: LayoutNode,
    row: number,
    col: number,
    height: number,
    width: number,
    regions: Map<string, LayoutRegion>,
  ): void {
    if (LayoutEngine.isSplit(node)) {
      const split = node as Split;
      if (split.type === 'vertical') {
        // Top/bottom split: divide height
        const firstH = Math.max(1, Math.min(Math.round(height * split.ratio), height - 1));
        const secondH = Math.max(1, height - firstH);
        LayoutEngine._computeNode(split.first, row, col, firstH, width, regions);
        LayoutEngine._computeNode(split.second, row + firstH, col, secondH, width, regions);
      } else {
        // Left/right split: divide width
        const firstW = Math.max(1, Math.min(Math.round(width * split.ratio), width - 1));
        const secondW = Math.max(1, width - firstW);
        LayoutEngine._computeNode(split.first, row, col, height, firstW, regions);
        LayoutEngine._computeNode(split.second, row, col + firstW, height, secondW, regions);
      }
    } else {
      // Leaf — assign region with auto-generated ID
      const id = nextRegionId();
      regions.set(id, {
        row,
        col,
        height: Math.max(1, height),
        width: Math.max(1, width),
      });
    }
  }

  /**
   * Recursively find and resize a split by ID.
   * Returns [newNode, changed] where changed is true if a modification was made.
   */
  private static _resizeNode(
    node: LayoutNode,
    splitId: string,
    delta: number,
  ): [LayoutNode, boolean] {
    if (!LayoutEngine.isSplit(node)) {
      return [node, false];
    }

    const split = node as Split;

    // Check if this is the split we're looking for
    if (split.id === splitId) {
      const newRatio = Math.max(0.1, Math.min(0.9, split.ratio + delta));
      return [{ ...split, ratio: newRatio }, true];
    }

    // Search children
    const [newFirst, firstChanged] = LayoutEngine._resizeNode(split.first, splitId, delta);
    if (firstChanged) {
      return [{ ...split, first: newFirst }, true];
    }

    const [newSecond, secondChanged] = LayoutEngine._resizeNode(split.second, splitId, delta);
    if (secondChanged) {
      return [{ ...split, second: newSecond }, true];
    }

    return [node, false];
  }
}
