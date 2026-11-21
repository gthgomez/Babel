/**
 * BL-01 regression: Chat preparation must be data-only for Python workspaces.
 * The previous readiness note imported the project package on the host, which
 * executed project code (including `__init__.py` side effects) before admission.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectWorkspaceDepReadinessNote } from './chatCore.js'

function pythonFixture(markerPath: string): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-dep-prep-static-'))
  mkdirSync(join(root, 'marker_pkg'), { recursive: true })
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "marker_pkg"\nversion = "0.0.0"\n')
  writeFileSync(join(root, 'marker_pkg', '__init__.py'),
    `from pathlib import Path\nPath(${JSON.stringify(markerPath)}).write_text("imported")\n`)
  return root
}

test('read-only Python preparation performs zero project initialization', () => {
  const parent = mkdtempSync(join(tmpdir(), 'babel-dep-prep-marker-'))
  const marker = join(parent, 'outside-marker.txt')
  const root = pythonFixture(marker)
  try {
    const note = collectWorkspaceDepReadinessNote(root)
    assert.match(note ?? '', /Dependency probing is disabled/)
    assert.equal(existsSync(marker), false, 'preparation must not import the project package')
    assert.equal(existsSync(join(root, 'marker_pkg', '__pycache__')), false,
      'preparation must not create Python bytecode caches')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true })
  }
})

test('Node workspaces keep the existing no-note control', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dep-prep-node-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'node-fixture', private: true }))
    assert.equal(collectWorkspaceDepReadinessNote(root), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
