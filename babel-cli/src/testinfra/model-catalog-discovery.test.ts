/**
 * Packaged-asset, offline-discovery and test-selection sentinel for the model
 * convergence campaign (C08).
 *
 * These cases prove that a clean install can start offline from the staged
 * model policy + generated catalog, and that every campaign test file is
 * actually selected by `test:unit` on a POSIX shell (where an unquoted `**`
 * pattern expands to one directory level and silently drops flat files).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveRuntimePaths } from '../config/runtimePaths.js'
import { discoverLiteCatalogModels, loadLiteCatalogSnapshot } from '../lite/config.js'
import { loadModelPolicyConfig } from '../modelPolicy.js'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const stageScript = join(packageRoot, 'scripts', 'stage_runtime_assets.mjs')
const repoCatalog = join(repoRoot, 'config', 'model-catalog.generated.json')
const repoPolicy = join(repoRoot, 'config', 'model-policy.json')
const packageJsonPath = join(packageRoot, 'package.json')

/** Every new `*.test.ts` introduced by C01-C06 (campaign base cf17c00..HEAD). */
const CAMPAIGN_NEW_TESTS = [
  'src/agent/context-budget.test.ts',
  'src/agent/providerCapabilities.test.ts',
  'src/intelligence/catalog-cache.test.ts',
  'src/intelligence/catalog-normalize.test.ts',
  'src/intelligence/catalog-refresh.test.ts',
  'src/intelligence/catalog.test.ts',
  'src/intelligence/model-ref.test.ts',
  'src/intelligence/openrouterMetadata.test.ts',
  'src/intelligence/price-quote.test.ts',
  'src/intelligence/profiles.test.ts',
  'src/intelligence/resolver.test.ts',
  'src/intelligence/route-selection.test.ts',
  'src/lite/config.test.ts',
].sort()

/** Directories whose model-convergence tests must never drop out of selection. */
const CAMPAIGN_TEST_DIRECTORIES = [
  'src/agent',
  'src/intelligence',
  'src/lite',
  'src/runners',
  'src/services',
]

function packageScripts(): Record<string, string> {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts: Record<string, string> }).scripts
}

function makeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function remove(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/** Minimal repo fixture with only the required staging inputs. */
function writeRepoFixture(options: { policyVersion: number; omitCatalog?: boolean }): string {
  const repo = makeTemp('babel stage repo é ')
  writeFileSync(join(repo, 'prompt_catalog.yaml'), 'assets: []\n')
  writeFileSync(join(repo, 'LICENSE'), 'Apache-2.0 fixture\n')
  mkdirSync(join(repo, 'config'), { recursive: true })
  if (options.omitCatalog !== true) {
    copyFileSync(repoCatalog, join(repo, 'config', 'model-catalog.generated.json'))
  }
  const policy = JSON.parse(readFileSync(repoPolicy, 'utf8')) as Record<string, unknown>
  policy['version'] = options.policyVersion
  writeFileSync(join(repo, 'config', 'model-policy.json'), `${JSON.stringify(policy, null, 2)}\n`)
  return repo
}

function makePackageRoot(): string {
  const root = makeTemp('babel stage pkg é ')
  mkdirSync(join(root, 'dist'), { recursive: true })
  return root
}

function runStage(repo: string, root: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [stageScript, repo, root], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

interface Selector {
  pattern: string
  quoted: boolean
}

function testUnitSelectors(): Selector[] {
  const command = packageScripts()['test:unit'] ?? ''
  const marker = ' --test '
  const tail = command.slice(command.indexOf(marker) + marker.length).trim()
  return tail.split(/\s+/).map((token) => ({
    pattern: token.replace(/^['"]|['"]$/g, ''),
    quoted: /^['"]/.test(token),
  }))
}

function walkTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return walkTestFiles(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function globToRegExp(pattern: string, mode: 'node' | 'shell'): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const expanded = mode === 'shell'
    // A POSIX shell without globstar treats `**` as a single `*` segment.
    ? escaped.replace(/\*/g, '[^/]*')
    : escaped
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:[^/]+/)*')
      .replace(/\u0001/g, '.*')
  return new RegExp(`^${expanded}$`)
}

test('selected_tests_equal_expected_inventory', () => {
  const scripts = packageScripts()
  const selectors = testUnitSelectors()
  const allSourceTests = walkTestFiles(join(packageRoot, 'src'))
    .map((file) => relative(packageRoot, file).split(sep).join('/'))
    .sort()

  const expand = (pattern: string, mode: 'node' | 'shell'): string[] => {
    const regexp = globToRegExp(pattern, mode)
    return allSourceTests.filter((file) => regexp.test(file))
  }

  // Intended inventory: what the runner selects when node expands every pattern.
  const intended = [...new Set(selectors.flatMap(({ pattern }) => expand(pattern, 'node')))].sort()

  // Executed inventory: how a POSIX `sh -c` expands the unquoted patterns before
  // node sees them, then node expands any literal pattern that matched nothing.
  const executed: string[] = []
  for (const { pattern, quoted } of selectors) {
    if (!pattern.includes('*')) {
      executed.push(pattern)
      continue
    }
    if (quoted) {
      executed.push(...expand(pattern, 'node'))
      continue
    }
    const shellMatches = expand(pattern, 'shell')
    executed.push(...(shellMatches.length > 0 ? shellMatches : expand(pattern, 'node')))
  }
  const executedUnique = [...new Set(executed)].sort()

  assert.deepEqual(
    executedUnique,
    intended,
    'the executed file inventory must equal the complete intended test:unit inventory',
  )
  assert.equal(executed.length, executedUnique.length, 'a selected test file must never run twice')

  // Every campaign test file is present in both the intended and executed sets.
  for (const file of CAMPAIGN_NEW_TESTS) {
    assert.ok(intended.includes(file), `${file} is missing from the intended test:unit inventory`)
    assert.ok(executedUnique.includes(file), `${file} is not executed by test:unit`)
  }

  // No test file in a campaign directory may fall outside the executed selection,
  // so a future nested directory cannot silently drop tests.
  for (const directory of CAMPAIGN_TEST_DIRECTORIES) {
    const present = allSourceTests.filter((file) => file.startsWith(`${directory}/`))
    const missing = present.filter((file) => !executedUnique.includes(file))
    assert.deepEqual(missing, [], `${directory} has test files outside the executed selection`)
  }

  // Recursive patterns must be quoted so the shell does not expand them to one level.
  for (const { pattern, quoted } of selectors.filter((selector) => selector.pattern.includes('**'))) {
    assert.equal(quoted, true, `recursive selector ${pattern} must be quoted for a portable full inventory`)
  }

  // Preserve the no-ambient-inference bootstrap and strict TAP required suites.
  assert.match(scripts['test:unit'] as string, /--import \.\/src\/testinfra\/register-no-ambient-inference\.mjs/)
  for (const suite of ['test:chat-truth', 'test:harness-runtime']) {
    assert.match(scripts[suite] as string, /--test-reporter=tap/)
    assert.match(scripts[suite] as string, /--test-concurrency=1/)
  }
  assert.ok(existsSync(join(packageRoot, 'scripts', 'capture_required_tap_selection.mjs')))
  assert.ok(existsSync(join(packageRoot, 'scripts', 'summarize_required_tap.mjs')))
  assert.ok(executedUnique.includes('src/testinfra/noAmbientInference.test.ts'))
  assert.ok(executedUnique.includes('src/testinfra/requiredTapSummary.test.ts'))
})

test('packed_catalog_present', () => {
  const repo = writeRepoFixture({ policyVersion: 2 })
  const root = makePackageRoot()
  try {
    const staged = runStage(repo, root)
    assert.equal(staged.status, 0, staged.stderr)
    const packedCatalog = join(root, 'resources', 'config', 'model-catalog.generated.json')
    const packedPolicy = join(root, 'resources', 'config', 'model-policy.json')
    assert.ok(existsSync(packedCatalog), 'packed resources must contain the generated catalog')
    assert.ok(existsSync(packedPolicy), 'packed resources must retain the model policy')
    assert.equal(readFileSync(packedCatalog, 'utf8'), readFileSync(repoCatalog, 'utf8'))
    // Exactly one authored catalog schema version ships an installed copy.
    assert.equal(
      (JSON.parse(readFileSync(packedCatalog, 'utf8')) as { schemaVersion?: number }).schemaVersion,
      1,
    )
  } finally {
    remove(repo)
    remove(root)
  }

  // A missing required asset fails closed before any resource replacement.
  const brokenRepo = writeRepoFixture({ policyVersion: 2, omitCatalog: true })
  const brokenRoot = makePackageRoot()
  const sentinel = join(brokenRoot, 'resources', 'sentinel.txt')
  try {
    mkdirSync(join(brokenRoot, 'resources'), { recursive: true })
    writeFileSync(sentinel, 'preserve me')
    const staged = runStage(brokenRepo, brokenRoot)
    assert.notEqual(staged.status, 0, 'a missing catalog must fail staging')
    assert.match(staged.stderr, /Missing runtime asset: config\/model-catalog\.generated\.json/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me', 'staging replaced resources before failing')
  } finally {
    remove(brokenRepo)
    remove(brokenRoot)
  }
})

test('packed_v2_and_v3_config_resolve', () => {
  const v2Repo = writeRepoFixture({ policyVersion: 2 })
  const v3Repo = writeRepoFixture({ policyVersion: 3 })
  const v2Root = makePackageRoot()
  const v3Root = makePackageRoot()
  const previousOverride = process.env['BABEL_MODEL_POLICY_PATH']
  delete process.env['BABEL_MODEL_POLICY_PATH']
  try {
    assert.equal(runStage(v2Repo, v2Root).status, 0)
    assert.equal(runStage(v3Repo, v3Root).status, 0)

    const v2 = loadModelPolicyConfig(join(v2Root, 'resources'))
    const v3 = loadModelPolicyConfig(join(v3Root, 'resources'))
    assert.equal(v2.config.version, 2)
    assert.equal(v3.config.version, 3)
    assert.equal(resolve(v2.path), resolve(join(v2Root, 'resources', 'config', 'model-policy.json')))
    assert.equal(resolve(v3.path), resolve(join(v3Root, 'resources', 'config', 'model-policy.json')))

    // The retained packed v2 stays readable as an explicit override beside a v3 default.
    process.env['BABEL_MODEL_POLICY_PATH'] = join(v2Root, 'resources', 'config', 'model-policy.json')
    const overridden = loadModelPolicyConfig(join(v3Root, 'resources'))
    assert.equal(overridden.config.version, 2)
    assert.equal(resolve(overridden.path), resolve(process.env['BABEL_MODEL_POLICY_PATH']))
  } finally {
    if (previousOverride === undefined) delete process.env['BABEL_MODEL_POLICY_PATH']
    else process.env['BABEL_MODEL_POLICY_PATH'] = previousOverride
    remove(v2Repo)
    remove(v3Repo)
    remove(v2Root)
    remove(v3Root)
  }
})

test('installed_offline_model_list_works', () => {
  const repo = writeRepoFixture({ policyVersion: 2 })
  const root = makePackageRoot()
  const home = makeTemp('babel installed home é ')
  try {
    assert.equal(runStage(repo, root).status, 0)
    const paths = resolveRuntimePaths({ HOME: home }, root)
    assert.equal(paths.isInstalled, true)
    assert.equal(paths.resourceRoot, join(root, 'resources'))
    assert.equal(paths.userCacheRoot, join(home, '.babel', 'cache'))

    // The installed fallback is the staged resource root, not the cache or cwd.
    const catalog = join(paths.resourceRoot, 'config', 'model-catalog.generated.json')
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      throw new Error('network is disabled in the installed offline test')
    }) as typeof fetch
    try {
      const snapshot = loadLiteCatalogSnapshot({ path: catalog })
      assert.equal(snapshot.schemaVersion, 1)
      assert.ok(snapshot.providerModels.length > 0)

      const models = discoverLiteCatalogModels({ path: catalog })
      assert.ok(models.length > 0)
      const glm = models.find((model) => model.ref.modelId === 'z-ai/glm-5.3-flash')
      assert.ok(glm, 'the installed snapshot projects provider-qualified models')
      assert.equal(glm.ref.provider, 'openrouter')
      assert.equal(fetchCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    remove(repo)
    remove(root)
    remove(home)
  }
})

test('model_package_changes_do_not_modify_installer', () => {
  const stageSource = readFileSync(stageScript, 'utf8')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { files: string[] }
  // PR308 is a separate, open installer path; the model package must not touch it.
  const installerSurface = /babel-desktop|installer|pr308|\.iss\b|\.wxs\b|nsis|package-windows/i
  assert.doesNotMatch(stageSource, installerSurface)
  for (const entry of packageJson.files) assert.doesNotMatch(entry, installerSurface)

  // Staging writes only the package-private resources tree and LICENSE.
  assert.match(stageSource, /resolve\(packageRoot, 'resources'\)/)
  assert.match(
    stageSource,
    /copyFileSync\(resolve\(repoRoot, 'LICENSE'\), resolve\(packageRoot, 'LICENSE'\)\)/,
  )
  const scriptNames = readdirSync(join(packageRoot, 'scripts'))
  assert.equal(
    scriptNames.some((name) => /\.(iss|wxs)$/.test(name) || /^installer/i.test(name)),
    false,
    'the model package must not author installer manifests',
  )
})
