import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { applyHunk, applyPatchInMemory, parseUnifiedDiff, reverseParsedPatch } from './patchApply.js'

const CLEAN_DIFF = `--- a/src/add.ts
+++ b/src/add.ts
@@ -1,3 +1,3 @@
 function add(a, b) {
-  return a - b
+  return a + b
 }
`

const ORIGINAL = 'function add(a, b) {\n  return a - b\n}\n'

describe('parseUnifiedDiff', () => {
  test('parses a clean single-file diff', () => {
    const parsed = parseUnifiedDiff(CLEAN_DIFF)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.files.length, 1)
    const file = parsed.files[0]!
    assert.equal(file.oldPath, 'src/add.ts')
    assert.equal(file.newPath, 'src/add.ts')
    assert.equal(file.hunks.length, 1)
    const hunk = file.hunks[0]!
    assert.equal(hunk.oldStart, 1)
    assert.equal(hunk.oldLines, 3)
    assert.equal(hunk.newStart, 1)
    assert.equal(hunk.newLines, 3)
  })

  test('rejects an empty patch', () => {
    const parsed = parseUnifiedDiff('   \n')
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.reason, 'empty_patch')
  })

  test('rejects a malformed hunk header', () => {
    const parsed = parseUnifiedDiff('--- a/f.ts\n+++ b/f.ts\n@@ broken @@\n x\n')
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.reason, 'bad_hunk_header')
    assert.equal(parsed.lineNo, 3)
  })

  test('rejects a hunk whose body counts mismatch the header', () => {
    const parsed = parseUnifiedDiff(
      '--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n',
    )
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.reason, 'hunk_count_mismatch')
  })

  test('rejects stray text outside hunks', () => {
    const parsed = parseUnifiedDiff('random noise line\n--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.reason, 'bad_hunk_body')
  })
})

describe('applyHunk fallback ladder', () => {
  test('level 1: exact context match', () => {
    const parsed = parseUnifiedDiff(CLEAN_DIFF)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const hunk = parsed.files[0]!.hunks[0]!
    const outcome = applyHunk(ORIGINAL, hunk)
    assert.ok(outcome.ok)
    if (outcome.ok) assert.equal(outcome.strategy, 'exact')
    assert.equal(outcome.content, 'function add(a, b) {\n  return a + b\n}\n')
  })

  test('level 2: line-trim (shifted indentation) match', () => {
    const parsed = parseUnifiedDiff(CLEAN_DIFF)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const hunk = parsed.files[0]!.hunks[0]!
    const indented = '    function add(a, b) {\n      return a - b\n    }\n'
    const outcome = applyHunk(indented, hunk)
    assert.ok(outcome.ok)
    if (outcome.ok) assert.equal(outcome.strategy, 'line_trim')
    assert.match(outcome.content, /return a \+ b/)
  })

  test('level 2b: whitespace-normalized match', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,3 @@
 alpha
- beta ()
+  beta(1)
 gamma
`
    const parsed = parseUnifiedDiff(diff)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const hunk = parsed.files[0]!.hunks[0]!
    // Internal-spacing drift: line-trim cannot reconcile it, whitespace
    // normalization (collapse runs to one space) can.
    const drifted = 'alpha\nbeta   ()\ngamma\n'
    const outcome = applyHunk(drifted, hunk)
    assert.ok(outcome.ok)
    if (outcome.ok) assert.equal(outcome.strategy, 'whitespace_normalized')
    assert.equal(outcome.content, 'alpha\n  beta(1)\ngamma\n')
  })

  test('level 3: fuzzy anchored apply when outer context is missing', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -2,5 +2,5 @@
 before
 mid
-  target
+  TARGET
 tail
 after
`
    const parsed = parseUnifiedDiff(diff)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const hunk = parsed.files[0]!.hunks[0]!
    // Outer context ("before", "after") shifted away; only the change and its
    // immediate neighbor survive.
    const shifted = 'unrelated\nmid\n  target\ntail\nunrelated2\n'
    const outcome = applyHunk(shifted, hunk)
    assert.ok(outcome.ok)
    if (outcome.ok) assert.equal(outcome.strategy, 'fuzzy_anchored')
    assert.equal(outcome.content, 'unrelated\nmid\n  TARGET\ntail\nunrelated2\n')
  })

  test('level 4: hunk fails (never silently skipped) when nothing matches', () => {
    const parsed = parseUnifiedDiff(CLEAN_DIFF)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const hunk = parsed.files[0]!.hunks[0]!
    const outcome = applyHunk('completely\ndifferent\ncontent\n', hunk)
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'not_found')
    assert.match(outcome.message, /does not apply/)
  })

  test('ambiguous match is a failure, not a guess', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,1 +1,1 @@
-dup
+DUP
`
    const parsed = parseUnifiedDiff(diff)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const hunk = parsed.files[0]!.hunks[0]!
    const outcome = applyHunk('dup\nother\ndup\n', hunk)
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'ambiguous')
  })
})

describe('applyPatchInMemory whole-patch semantics', () => {
  test('clean multi-hunk patch applies', () => {
    const parsed = parseUnifiedDiff(CLEAN_DIFF)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const applied = applyPatchInMemory(parsed.files, () => ORIGINAL)
    assert.ok(applied.ok)
    if (!applied.ok) return
    assert.equal(applied.results[0]!.content, 'function add(a, b) {\n  return a + b\n}\n')
    assert.equal(applied.results[0]!.appliedHunks, 1)
  })

  test('conflicting patch is all-or-nothing: nothing applied, diagnostics returned', () => {
    const patch = `--- a/one.ts
+++ b/one.ts
@@ -1,1 +1,1 @@
-x
+X
--- a/two.ts
+++ b/two.ts
@@ -1,1 +1,1 @@
-missing
+FOUND
`
    const parsed = parseUnifiedDiff(patch)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const applied = applyPatchInMemory(parsed.files, (path) =>
      path === 'one.ts' ? 'x\n' : 'unrelated\n',
    )
    assert.equal(applied.ok, false)
    if (applied.ok) return
    assert.equal(applied.failures.length, 1)
    assert.equal(applied.failures[0]!.file, 'two.ts')
    assert.equal(applied.failures[0]!.hunkIndex, 0)
    assert.match(applied.diagnostics, /HUNK FAILED/)
    assert.match(applied.diagnostics, /two\.ts/)
  })

  test('creates-file sections start from empty content', () => {
    const patch = `--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
`
    const parsed = parseUnifiedDiff(patch)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    assert.equal(parsed.files[0]!.createsFile, true)
    const applied = applyPatchInMemory(parsed.files, () => '')
    assert.ok(applied.ok)
    if (!applied.ok) return
    assert.equal(applied.results[0]!.content, 'hello\nworld\n')
  })
})

describe('round-trip property: apply(reverse(apply(patch)))', () => {
  test('reversing an applied patch restores the original content', () => {
    const parsed = parseUnifiedDiff(CLEAN_DIFF)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const forward = applyPatchInMemory(parsed.files, () => ORIGINAL)
    assert.ok(forward.ok)
    if (!forward.ok) return
    const patched = forward.results[0]!.content

    const reversed = reverseParsedPatch(parsed.files)
    const backward = applyPatchInMemory(reversed, () => patched)
    assert.ok(backward.ok, backward.ok ? '' : backward.diagnostics)
    if (!backward.ok) return
    assert.equal(backward.results[0]!.content, ORIGINAL)
  })

  test('round-trips over randomized-ish multi-file patches', () => {
    const patch = `--- a/alpha.ts
+++ b/alpha.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 22
+const c = 3
 const d = 4
--- a/beta/gamma.ts
+++ b/beta/gamma.ts
@@ -2,3 +2,2 @@
 import x
-export { y }
 import z
`
    const originals: Record<string, string> = {
      'alpha.ts': 'const a = 1\nconst b = 2\nconst d = 4\n',
      'beta/gamma.ts': 'header\nimport x\nexport { y }\nimport z\n',
    }
    const parsed = parseUnifiedDiff(patch)
    assert.ok(parsed.ok)
    if (!parsed.ok) return
    const forward = applyPatchInMemory(parsed.files, (p) => originals[p] ?? '')
    assert.ok(forward.ok, forward.ok ? '' : forward.diagnostics)
    if (!forward.ok) return
    const patchedContents = new Map(forward.results.map((r) => [r.path, r.content]))

    const reversed = reverseParsedPatch(parsed.files)
    const backward = applyPatchInMemory(reversed, (p) => patchedContents.get(p) ?? '')
    assert.ok(backward.ok, backward.ok ? '' : backward.diagnostics)
    if (!backward.ok) return
    for (const result of backward.results) {
      assert.equal(result.content, originals[result.path])
    }
  })
})
