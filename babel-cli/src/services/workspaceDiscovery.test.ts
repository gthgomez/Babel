import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { WorkspaceScanner } from './workspaceDiscovery.js'

test('workspace discovery preserves directory names and resolves them without case sensitivity', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-discovery-'))
  const project = join(workspace, 'example_game_suite', 'Mixed-Case.Project')
  const nested = join(project, 'src', 'scenes')
  try {
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(project, 'package.json'), '{}')
    const scanner = new WorkspaceScanner(workspace)

    const detected = scanner.detectFromCwd(nested)
    assert.equal(detected?.name, 'Mixed-Case.Project')
    assert.equal(detected?.root, project)
    assert.equal(scanner.resolveProjectPath('mixed-case.project'), project)
    assert.equal(scanner.resolveProjectPath('MIXED-CASE.PROJECT'), project)
    assert.equal(scanner.isKnownProject('unknown-project'), false)
    assert.equal(scanner.resolveProjectPath('unknown-project'), null)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
