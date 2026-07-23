/**
 * Tests for LayoutEngine — recursive partitioning layout system.
 *
 * @module layout.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutEngine, type LayoutNode, type Split, type LayoutRegion } from './layout.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a leaf node (placeholder) for the layout tree. */
function leaf(): LayoutRegion {
  return { row: 1, col: 1, height: 1, width: 1 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LayoutEngine', () => {
  describe('compute', () => {
    it('should compute a single leaf region at full terminal size', () => {
      const root: LayoutNode = leaf();
      const regions = LayoutEngine.compute(root, 24, 80);

      assert.equal(regions.size, 1);
      const region = regions.get('pane-1');
      assert.ok(region);
      assert.equal(region.row, 1);
      assert.equal(region.col, 1);
      assert.equal(region.height, 24);
      assert.equal(region.width, 80);
    });

    it('should handle a horizontal split at 0.5 ratio (two equal left/right regions)', () => {
      const root: Split = {
        type: 'horizontal',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      assert.equal(regions.size, 2);

      const r1 = regions.get('pane-1');
      const r2 = regions.get('pane-2');
      assert.ok(r1);
      assert.ok(r2);

      // Two equal halves horizontally
      assert.equal(r1.row, 1);
      assert.equal(r1.col, 1);
      assert.equal(r1.height, 24);
      assert.equal(r1.width, 40);

      assert.equal(r2.row, 1);
      assert.equal(r2.col, 41);
      assert.equal(r2.height, 24);
      assert.equal(r2.width, 40);
    });

    it('should handle a vertical split at 0.3 ratio (30/70 top/bottom)', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.3,
        first: leaf(),
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      assert.equal(regions.size, 2);

      const r1 = regions.get('pane-1');
      const r2 = regions.get('pane-2');
      assert.ok(r1);
      assert.ok(r2);

      // 30% of 24 rows = 7.2 → 7 rows for first, 17 for second
      assert.equal(r1.height, 7);
      assert.equal(r2.height, 17);

      // Both full width
      assert.equal(r1.width, 80);
      assert.equal(r2.width, 80);

      // Positions
      assert.equal(r1.row, 1);
      assert.equal(r2.row, 8);
    });

    it('should handle a nested split (vertical then horizontal in bottom)', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.3,
        first: leaf(),
        second: {
          type: 'horizontal',
          ratio: 0.5,
          first: leaf(),
          second: leaf(),
        },
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      assert.equal(regions.size, 3);

      // pane-1: top 30%
      const r1 = regions.get('pane-1');
      assert.ok(r1);
      assert.equal(r1.row, 1);
      assert.equal(r1.height, 7);

      // pane-2: bottom-left (50% of bottom = 50% of 70% of height)
      const r2 = regions.get('pane-2');
      assert.ok(r2);
      assert.equal(r2.row, 8);
      assert.equal(r2.height, 17);
      assert.equal(r2.col, 1);
      assert.equal(r2.width, 40);

      // pane-3: bottom-right
      const r3 = regions.get('pane-3');
      assert.ok(r3);
      assert.equal(r3.row, 8);
      assert.equal(r3.height, 17);
      assert.equal(r3.col, 41);
      assert.equal(r3.width, 40);
    });

    it('should assign unique regionIds in DFS order', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      const keys = [...regions.keys()];
      assert.equal(keys.length, 2);
      assert.equal(keys[0], 'pane-1');
      assert.equal(keys[1], 'pane-2');
    });

    it('should reset IDs on each call', () => {
      const root: LayoutNode = leaf();

      const r1 = LayoutEngine.compute(root, 24, 80);
      const r2 = LayoutEngine.compute(root, 24, 80);

      // Both calls produce the same IDs
      assert.equal([...r1.keys()][0], 'pane-1');
      assert.equal([...r2.keys()][0], 'pane-1');
    });

    it('should handle a 1x1 terminal without errors', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 1, 1);

      assert.equal(regions.size, 2);
      for (const r of regions.values()) {
        assert.ok(r.height >= 1);
        assert.ok(r.width >= 1);
      }
    });

    it('should always produce at least 1 row/col per region', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.01, // Very skewed
        first: leaf(),
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 2, 80);

      assert.equal(regions.size, 2);
      for (const r of regions.values()) {
        assert.ok(r.height >= 1);
      }
    });

    it('should partition space completely (no gaps)', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.3,
        first: {
          type: 'horizontal',
          ratio: 0.5,
          first: leaf(),
          second: leaf(),
        },
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      // The tree is: vertical split at 30%, first child is a horizontal split.
      // - pane-1 and pane-2 are in the horizontal split (top 30% of height, left/right halves)
      // - pane-3 is the second child of the vertical split (bottom 70%)
      const r1 = regions.get('pane-1');
      const r2 = regions.get('pane-2');
      const r3 = regions.get('pane-3');
      assert.ok(r1);
      assert.ok(r2);
      assert.ok(r3);

      // pane-1 and pane-2 share the same vertical span (top portion)
      assert.equal(r1.row, r2.row);
      assert.equal(r1.height, r2.height);
      assert.equal(r1.row + r1.height - 1, r2.row + r2.height - 1);

      // pane-3 starts where pane-1/pane-2 ends
      assert.equal(r3.row, r1.row + r1.height);

      // pane-1 is left half, pane-2 is right half
      assert.equal(r1.width, r2.width);
      assert.equal(r1.col, 1);
      assert.equal(r2.col, r1.col + r1.width);

      // Full width coverage
      assert.equal(r1.width + r2.width, 80);

      // pane-3 is full width, spanning from its start to terminal bottom
      assert.equal(r3.width, 80);
      assert.equal(r3.row + r3.height - 1, 24);

      // All regions are within bounds
      for (const r of regions.values()) {
        assert.ok(r.row >= 1);
        assert.ok(r.col >= 1);
        assert.ok(r.row + r.height - 1 <= 24);
        assert.ok(r.col + r.width - 1 <= 80);
      }
    });
  });

  describe('regionAt', () => {
    it('should find the region at a given position', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      // Top half
      assert.equal(LayoutEngine.regionAt(regions, 1, 1), 'pane-1');
      assert.equal(LayoutEngine.regionAt(regions, 12, 40), 'pane-1');

      // Bottom half
      assert.equal(LayoutEngine.regionAt(regions, 13, 1), 'pane-2');
      assert.equal(LayoutEngine.regionAt(regions, 24, 80), 'pane-2');
    });

    it('should return null for positions outside any region', () => {
      const root: LayoutNode = leaf();
      const regions = LayoutEngine.compute(root, 24, 80);

      assert.equal(LayoutEngine.regionAt(regions, 0, 1), null);
      assert.equal(LayoutEngine.regionAt(regions, 1, 0), null);
      assert.equal(LayoutEngine.regionAt(regions, 25, 1), null);
    });

    it('should find regions in a nested layout', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: {
          type: 'horizontal',
          ratio: 0.5,
          first: leaf(),
          second: leaf(),
        },
        second: leaf(),
      };

      const regions = LayoutEngine.compute(root, 24, 80);

      const r1 = regions.get('pane-1');
      const r2 = regions.get('pane-2');
      const r3 = regions.get('pane-3');
      assert.ok(r1);
      assert.ok(r2);
      assert.ok(r3);

      // pane-1: top-left
      assert.equal(
        LayoutEngine.regionAt(regions, r1.row, r1.col),
        'pane-1',
      );
      // pane-2: top-right
      assert.equal(
        LayoutEngine.regionAt(regions, r2.row, r2.col),
        'pane-2',
      );
      // pane-3: bottom
      assert.equal(
        LayoutEngine.regionAt(regions, r3.row, r3.col),
        'pane-3',
      );
    });
  });

  describe('resize', () => {
    it('should increase a split ratio by delta', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
        id: 'split-1',
      };

      const result = LayoutEngine.resize(root, 'split-1', 0.1);
      assert.ok(LayoutEngine.isSplit(result));
      const resized = result as Split;
      assert.equal(resized.ratio, 0.6);
    });

    it('should decrease a split ratio by delta', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
        id: 'split-1',
      };

      const result = LayoutEngine.resize(root, 'split-1', -0.1);
      assert.ok(LayoutEngine.isSplit(result));
      const resized = result as Split;
      assert.equal(resized.ratio, 0.4);
    });

    it('should clamp ratio to [0.1, 0.9]', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
        id: 'split-1',
      };

      // Clamp to 0.9
      const r1 = LayoutEngine.resize(root, 'split-1', 1.0) as Split;
      assert.equal(r1.ratio, 0.9);

      // Clamp to 0.1
      const r2 = LayoutEngine.resize(root, 'split-1', -1.0) as Split;
      assert.equal(r2.ratio, 0.1);
    });

    it('should not modify the original root (immutability)', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
        id: 'split-1',
      };

      const originalRatio = root.ratio;
      LayoutEngine.resize(root, 'split-1', 0.2);

      // Original should be unchanged
      assert.equal(root.ratio, originalRatio);
    });

    it('should return original root when split ID is not found', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
        id: 'split-1',
      };

      const result = LayoutEngine.resize(root, 'nonexistent', 0.1);
      assert.ok(LayoutEngine.isSplit(result));
      assert.equal((result as Split).ratio, 0.5);
    });
  });

  describe('isSplit / isLeaf', () => {
    it('should identify a Split node', () => {
      const split: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      assert.ok(LayoutEngine.isSplit(split));
      assert.ok(!LayoutEngine.isLeaf(split));
    });

    it('should identify a leaf LayoutRegion', () => {
      const region: LayoutRegion = { row: 1, col: 1, height: 1, width: 1 };

      assert.ok(!LayoutEngine.isSplit(region));
      assert.ok(LayoutEngine.isLeaf(region));
    });
  });

  describe('leafCount', () => {
    it('should return 1 for a single leaf', () => {
      const count = LayoutEngine.leafCount(leaf());
      assert.equal(count, 1);
    });

    it('should count leaves in a split tree', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: {
          type: 'horizontal',
          ratio: 0.5,
          first: leaf(),
          second: leaf(),
        },
      };

      assert.equal(LayoutEngine.leafCount(root), 3);
    });
  });

  describe('mapLeaves', () => {
    it('should transform each leaf via the visit function', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      let callCount = 0;
      const mapped = LayoutEngine.mapLeaves(root, (l, i) => {
        callCount++;
        assert.equal(i, callCount - 1);
        return l;
      });

      assert.equal(callCount, 2);
      assert.ok(LayoutEngine.isSplit(mapped));
    });
  });

  describe('replaceLeaf', () => {
    it('should replace a leaf at the given index', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      const replacement: Split = {
        type: 'horizontal',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
        id: 'replacement',
      };

      const result = LayoutEngine.replaceLeaf(root, 0, replacement);

      // The first leaf should now be a split
      assert.ok(LayoutEngine.isSplit(result));
      const s = result as Split;
      assert.ok(LayoutEngine.isSplit(s.first));
      assert.equal((s.first as Split).id, 'replacement');
    });
  });

  describe('findLeafByIndex', () => {
    it('should find a leaf by DFS index', () => {
      const root: Split = {
        type: 'vertical',
        ratio: 0.5,
        first: leaf(),
        second: leaf(),
      };

      const found = LayoutEngine.findLeafByIndex(root, 0);
      assert.ok(found);
      assert.equal(found.index, 0);
      assert.ok(found.parent !== null); // root split is the parent
    });

    it('should return null for out-of-bounds index', () => {
      const root: LayoutNode = leaf();
      const found = LayoutEngine.findLeafByIndex(root, 5);
      assert.equal(found, null);
    });
  });
});
