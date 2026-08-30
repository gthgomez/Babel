import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createManifest,
  validateDirectory,
  validatePackageInput,
  zipDirectory,
} from '../final-recertification-package-lib.mjs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const report = `# Final report

## FINAL_VERDICT
BLOCKED
## FINAL_REPOSITORY_STATE
pending
## PR_DISPOSITION
pending
## REQUIRED_FIXES
pending
## CERTIFICATION
pending
## CLEANUP
pending
## LIVE_DEEPSWE
pending
## REMAINING_RISKS
pending
## REVIEW_PACKAGE
pending
`

function writeFixture(root, files) {
  for (const [path, value] of Object.entries(files)) {
    const destination = join(root, path)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, value)
  }
  writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify(createManifest(root, {
    finalMainSha: 'a'.repeat(40),
    sourceCommit: 'b'.repeat(40),
  }), null, 2) + '\n')
}

function baseFiles() {
  return {
    'FINAL_REPORT.md': report,
    'repository/changed-files.txt': 'babel-cli/src/runners/deepInfraApi.ts\n',
    'repository/implementation.diff': 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    'repository/status.txt': 'CLEAN\n',
    'verification/STATUS.json': '{"status":"PASS"}\n',
    'trust-gate/agent-pr-gate.ps1': '$result = @{ status = "PASS" }\n',
    'cleanup/STATUS.json': '{"status":"PASS"}\n',
    'live-eval/STATUS.json': '{"status":"NOT_RUN"}\n',
  }
}

test('final recertification package validates semantics and ZIP extraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-package-test-'))
  try {
    writeFixture(root, baseFiles())
    const directory = validateDirectory(root)
    assert.equal(directory.status, 'PASS')
    assert.equal(directory.semantic_validation, 'PASS')
    assert.equal(directory.duplicate_validation, 'PASS')
    assert.equal(directory.secret_scan, 'PASS')

    const zip = join(root, '..', 'babel-final-package-test.zip')
    zipDirectory(root, zip)
    const archive = validatePackageInput(zip)
    assert.equal(archive.status, 'PASS')
    assert.equal(archive.extraction_reverification, 'PASS')
    assert.equal(archive.manifest_file_count, directory.manifest_file_count)
    rmSync(zip, { force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('final recertification package rejects help output advertised as a diff', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-package-help-test-'))
  try {
    writeFixture(root, {
      ...baseFiles(),
      'repository/implementation.diff': 'usage: git diff [options]\n',
    })
    const result = validateDirectory(root)
    assert.equal(result.status, 'FAIL')
    assert.equal(result.semantic_validation, 'FAIL')
    assert.ok(result.errors.some((error) => error.includes('advertised diff')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('final recertification package rejects unlisted byte-identical before/after evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-package-duplicate-test-'))
  try {
    writeFixture(root, {
      ...baseFiles(),
      'trust-gate/trusted-gate.before.ps1': '$x = 1\n',
      'trust-gate/trusted-gate.after.ps1': '$x = 1\n',
    })
    const result = validateDirectory(root)
    assert.equal(result.status, 'FAIL')
    assert.equal(result.duplicate_validation, 'FAIL')
    assert.ok(result.errors.some((error) => error.includes('byte-identical evidence')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('final recertification package rejects secret-shaped evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-package-secret-test-'))
  try {
    writeFixture(root, {
      ...baseFiles(),
      'verification/provider-receipt.json': JSON.stringify({
        token: ['ghp', '123456789012345678901234'].join('_'),
      }),
    })
    const result = validateDirectory(root)
    assert.equal(result.status, 'FAIL')
    assert.equal(result.secret_scan, 'FAIL')
    assert.ok(result.errors.some((error) => error.includes('secret scan failed')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('final recertification package rejects non-canonical manifest paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-package-manifest-path-test-'))
  try {
    writeFixture(root, baseFiles())
    const manifestPath = join(root, 'MANIFEST.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.entries[0].path = `./${manifest.entries[0].path}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = validateDirectory(root)
    assert.equal(result.status, 'FAIL')
    assert.ok(result.errors.some((error) => error.includes('path is not canonical')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
