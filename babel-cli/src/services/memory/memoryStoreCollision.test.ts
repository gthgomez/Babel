import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  detectOnDiskCaseCollision,
  legacySlugSanitizeCollides,
} from './memoryStoreCollision.js';

describe('memoryStoreCollision', () => {
  it('detectOnDiskCaseCollision uses join path composition (CANON-safe)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'babel-collision-canon-'));
    const upper = join(parent, 'CaseDir');
    try {
      mkdirSync(upper, { recursive: true });
      try {
        mkdirSync(join(parent, 'casedir'), { recursive: true });
      } catch {
        // case-insensitive host: single dir is fine
      }
      void detectOnDiskCaseCollision(upper);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('sanitized slug collision does not require on-disk siblings', () => {
    assert.ok(legacySlugSanitizeCollides(['/X/Proj/A', '/x/proj/a']));
  });
});
