import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createManifest,
  PACKAGE_SCHEMA,
  sha256,
  validateDirectory,
  validatePackageInput,
  zipDirectory,
} from './final-recertification-package-lib.mjs'

const SOURCE_EVIDENCE_PATHS = [
  'babel-cli/src/runners/base.ts',
  'babel-cli/src/runners/providerFailureReceipt.ts',
  'babel-cli/src/runners/deepInfraApi.ts',
  'babel-cli/src/runners/deepSeekApi.ts',
  'babel-cli/src/runners/providerReliabilityAdversarial.test.ts',
  'babel-cli/src/agent/sessionEvents.ts',
  'babel-cli/src/agent/executionLifecycle.ts',
  'babel-cli/src/agent/agentEndpoint.ts',
  'babel-cli/src/authority/trustedExecutionPort.ts',
  'babel-cli/src/authority/trustedExecutionSupervisor.ts',
  'babel-cli/src/evidence/trustedExecutionIdentity.ts',
  'babel-cli/src/evidence/independentReview.ts',
  'babel-cli/src/authority/trustedExecutionPort.architecture.test.ts',
  'babel-cli/src/agent/lanes/readOnlyAgentLoop.ts',
  'babel-cli/src/tools/chronicleMemory.ts',
  'babel-cli/src/modelPolicy.ts',
  'babel-cli/src/services/agentBenchmarkHarness.ts',
  'babel-cli/src/services/agentBenchmarkHarness.test.ts',
  'babel-cli/src/services/liteTrustDemo.ts',
  'babel-cli/src/eval/canary/liveCell.ts',
  'babel-cli/src/eval/canary/canary.test.ts',
  'babel-cli/src/runners/openRouterApi.ts',
  'babel-cli/src/runners/openRouterApi.test.ts',
]

// Keep the default trust-gate snapshot disjoint from source-evidence/. The
// semantic validator intentionally rejects accidental byte-identical copies
// that are assigned different evidence roles.
const TRUST_GATE_FALLBACK_PATHS = [
  '.github/workflows/typecheck.yml',
  '.github/workflows/trusted-control-plane.yml',
  'scripts/agent-git-common.psm1',
  'scripts/agent-pr-gate-common.psm1',
  'scripts/agent-pr-gate.ps1',
  'scripts/trusted-merge-gate.ps1',
  'scripts/bootstrap-trust-root.ps1',
  'scripts/verify-independent-review.mjs',
  'config/independent-review-keys.json',
  'config/trusted-supervisor-keys.json',
  'tools/check-public-pr-metadata.ps1',
  'tools/security/public-pr-metadata-policy.json',
  'tools/tests/test-agent-git-readiness.ps1',
  'tools/tests/test-public-pr-metadata.ps1',
  'tools/tests/test-trust-root-boundaries.ps1',
  'docs/architecture/PR120_PR126_RECONCILIATION.md',
  'PR126_BOOTSTRAP_RECONCILIATION.md',
  'docs/architecture/TRUST_ORDER_ANALYSIS.md',
  'docs/architecture/REPOSITORY_CONSOLIDATION_LEDGER.md',
  'docs/architecture/TRUSTED_READ_PORT_BOUNDARY.md',
]

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function git(repo, args, fallback = 'UNAVAILABLE') {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trimEnd() || fallback
  } catch {
    return fallback
  }
}

function inside(child, parent) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`, 'utf8')
}

function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2))
}

function forbiddenEvidenceName(path) {
  const lower = path.toLowerCase().replaceAll('\\', '/')
  const file = lower.slice(lower.lastIndexOf('/') + 1)
  return (
    file === '.env' ||
    file.startsWith('.env.') ||
    file === 'auth.json' ||
    file.includes('credentials') ||
    file.endsWith('.pem') ||
    file.endsWith('.key')
  )
}

function safeFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`refusing to package symbolic link: ${path}`)
      if (forbiddenEvidenceName(path)) throw new Error(`refusing to package credential-like evidence path: ${path}`)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(resolve(root))
  return files.sort()
}

function copyFile(source, destination) {
  if (forbiddenEvidenceName(source)) throw new Error(`refusing to copy credential-like evidence path: ${source}`)
  const data = readFileSync(source)
  if (data.byteLength > 64 * 1024 * 1024) throw new Error(`evidence file exceeds 64 MiB: ${source}`)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, data)
}

function copyTree(source, destination) {
  const root = resolve(source)
  for (const file of safeFiles(root)) copyFile(file, join(destination, relative(root, file)))
}

function copyIfPresent(repo, source, destination, stage) {
  const absolute = join(repo, source)
  if (existsSync(absolute) && statSync(absolute).isFile()) copyFile(absolute, join(stage, destination))
}

function gitDiff(repo, base) {
  if (!/^[a-f0-9]{40}$/i.test(base)) return ''
  try {
    return execFileSync('git', [
      'diff', '--full-index', '--no-ext-diff', base, '--', ...SOURCE_EVIDENCE_PATHS,
    ], { cwd: repo, encoding: 'utf8' })
  } catch {
    return ''
  }
}

function statusForRoot(root) {
  return root && existsSync(root) ? 'SUPPLIED' : 'NOT_SUPPLIED'
}

function makeReport({ head, originMain, branch, verificationStatus, cleanupStatus, liveStatus, verdict, models }) {
  return `# Babel final recertification report

## FINAL_VERDICT

${verdict}

The package records only evidence supplied at build time; external merge, cleanup, and paid live-evaluation claims remain blocked unless their corresponding evidence is present and independently verified.

## FINAL_REPOSITORY_STATE

- final origin/main SHA: ${originMain}
- canonical local path: recorded in repository/canonical-path.txt
- local HEAD SHA: ${head}
- clean status: recorded in repository/git-status.txt
- worktree count: recorded in repository/worktrees.txt
- local non-main branch count: recorded in repository/branches.txt
- remote non-main branch count: recorded in repository/remote-branches.txt
- open PR count: recorded in repository/pr-disposition.json

## PR_DISPOSITION

See repository/pr-disposition.json. The builder does not infer disposition from local Git state.

## REQUIRED_FIXES

F1 | BLOCKED | Exact-head trusted-control-plane evidence is required.
F2 | ${verificationStatus === 'SUPPLIED' ? 'FIXED' : 'BLOCKED'} | Provider adversarial test evidence is ${verificationStatus === 'SUPPLIED' ? 'included under verification/.' : 'not supplied to this package build.'}
F3 | ${verificationStatus === 'SUPPLIED' ? 'FIXED' : 'BLOCKED'} | Provider adversarial test evidence is ${verificationStatus === 'SUPPLIED' ? 'included under verification/.' : 'not supplied to this package build.'}
F4 | FIXED | This package is gated by semantic, duplicate, secret, and extraction validation.
F5 | BLOCKED | Current PR metadata evidence is required.
F6 | BLOCKED | Current PR reconciliation evidence is required.
F7 | NARROWED_CLAIM | The read-port documentation states an in-process boundary and does not claim hostile-process resistance.

## CERTIFICATION

- focused provider adversarial tests: see ${verificationStatus === 'SUPPLIED' ? 'verification/' : 'verification/STATUS.json'}
- trust/gate tests: see trust-gate/ and verification/
- broad local test summaries: not inferred by the package builder
- exact-head required GitHub checks: not inferred by the package builder
- post-merge smoke result: not inferred by the package builder

## CLEANUP

- Babel clones discovered: see cleanup/ when supplied
- redundant clones deleted: see cleanup/ when supplied
- worktrees removed: see cleanup/ when supplied
- local branches deleted: see cleanup/ when supplied
- remote branches deleted: see cleanup/ when supplied
- unique content reconciliation/preservation: see cleanup/ when supplied
- final cleanup invariant status: ${cleanupStatus}

## LIVE_DEEPSWE

- certified starting SHA: ${originMain}
- exact DeepSeek Flash OpenRouter ID: ${models.deepseek}
- exact GLM 5.3 Flash OpenRouter ID: ${models.glm}
- tasks: see live-eval/experiment-manifest.json when supplied
- cells attempted/completed: see live-eval/
- verified successes per model: see live-eval/
- harness defects: see live-eval/
- provider failures: see live-eval/
- UNKNOWNs: see live-eval/
- total OpenRouter cost: see live-eval/cost.json when supplied
- most important diagnostic conclusion: not inferred by the package builder

## REMAINING_RISKS

- Exact-head GitHub disposition may be absent.
- Local cleanup may be incomplete.
- Paid live-evaluation evidence may be absent or incomplete.
- Model/provider identity and cost remain UNKNOWN until current external evidence is supplied.

## REVIEW_PACKAGE

- absolute ZIP path: written by the build command
- ZIP SHA-256: written by the build command
- manifest file count: written by the build command
- semantic validation result: required before ZIP creation
- duplicate-artifact validation result: required before ZIP creation
- secret-scan result: required before ZIP creation
- extraction/rehash validation result: required after ZIP creation
`
}

const repo = resolve(argument('--repo', process.cwd()))
const requestedOutput = argument(
  '--output',
  join(tmpdir(), `babel-final-recertification-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.zip`),
)
const output = resolve(requestedOutput)
if (!existsSync(repo)) throw new Error(`repository does not exist: ${repo}`)
if (inside(output, repo)) throw new Error('final review ZIP must be outside the Babel repository')
if (existsSync(output) && !hasFlag('--force')) throw new Error(`output already exists; use --force to replace it: ${output}`)

const evidenceRoots = {
  verification: argument('--verification-root'),
  trustGate: argument('--trust-gate-root'),
  cleanup: argument('--cleanup-root'),
  live: argument('--live-root'),
  historical: argument('--historical-root'),
  prSnapshot: argument('--pr-snapshot'),
  intentionalDuplicates: argument('--intentional-duplicates'),
}
if (hasFlag('--require-complete')) {
  for (const [name, root] of Object.entries(evidenceRoots)) {
    if (name === 'prSnapshot' || name === 'intentionalDuplicates') continue
    if (!root || !existsSync(root)) throw new Error(`--require-complete requires ${name} evidence`)
  }
}

const stage = mkdtempSync(join(tmpdir(), 'babel-final-recertification-stage-'))
try {
  const head = git(repo, ['rev-parse', 'HEAD'])
  const originMain = git(repo, ['rev-parse', 'origin/main'])
  const branch = git(repo, ['branch', '--show-current'])
  const verificationStatus = statusForRoot(evidenceRoots.verification)
  const cleanupStatus = statusForRoot(evidenceRoots.cleanup)
  const liveStatus = statusForRoot(evidenceRoots.live)
  const models = {
    deepseek: argument('--deepseek-model', 'NOT_RESOLVED_UNTIL_OPENROUTER_METADATA'),
    glm: argument('--glm-model', 'NOT_RESOLVED_UNTIL_OPENROUTER_METADATA'),
  }
  const verdict = argument('--verdict', 'BLOCKED')
  if (!['COMPLETE_CERTIFIED_CLEAN_LIVE_EVAL_COMPLETE', 'CODE_CERTIFIED_CLEAN_LIVE_EVAL_BLOCKED', 'BLOCKED'].includes(verdict)) {
    throw new Error(`unsupported final verdict: ${verdict}`)
  }

  writeText(join(stage, 'repository', 'canonical-path.txt'), repo)
  writeText(join(stage, 'repository', 'base-sha.txt'), originMain)
  writeText(join(stage, 'repository', 'head-sha.txt'), head)
  writeText(join(stage, 'repository', 'branch.txt'), branch)
  writeText(join(stage, 'repository', 'origin.txt'), git(repo, ['remote', 'get-url', 'origin']))
  writeText(join(stage, 'repository', 'git-status.txt'), git(repo, ['status', '--short', '--branch', '--untracked-files=all'], 'CLEAN'))
  writeText(join(stage, 'repository', 'changed-files.txt'), git(repo, ['diff', '--name-status', originMain], 'NO_CHANGES'))
  writeText(join(stage, 'repository', 'branches.txt'), git(repo, ['branch', '--format=%(refname:short)'], 'UNKNOWN'))
  writeText(join(stage, 'repository', 'remote-branches.txt'), git(repo, ['branch', '--remotes', '--format=%(refname:short)'], 'UNKNOWN'))
  writeJson(join(stage, 'repository', 'pr-disposition.json'), {
    schemaVersion: 1,
    status: evidenceRoots.prSnapshot && existsSync(evidenceRoots.prSnapshot) ? 'SUPPLIED_SEPARATELY' : 'NOT_SUPPLIED',
    source: evidenceRoots.prSnapshot || null,
  })
  writeText(join(stage, 'repository', 'source-integrity.txt'), 'STATUS: NOT_INFERRED_BY_BUILDER')

  const diff = gitDiff(repo, originMain)
  if (diff.trim()) writeText(join(stage, 'repository', 'final-implementation.diff'), diff)
  for (const source of SOURCE_EVIDENCE_PATHS) copyIfPresent(repo, source, join('source-evidence', source), stage)

  if (evidenceRoots.prSnapshot && existsSync(evidenceRoots.prSnapshot)) {
    if (statSync(evidenceRoots.prSnapshot).isDirectory()) copyTree(evidenceRoots.prSnapshot, join(stage, 'repository', 'pr-snapshot'))
    else copyFile(evidenceRoots.prSnapshot, join(stage, 'repository', 'pr-snapshot', 'snapshot.json'))
  }
  if (evidenceRoots.historical && existsSync(evidenceRoots.historical)) copyTree(evidenceRoots.historical, join(stage, 'repository', 'historical-reconciliation'))

  const trustSources = evidenceRoots.trustGate && existsSync(evidenceRoots.trustGate)
    ? evidenceRoots.trustGate
    : null
  if (trustSources) copyTree(trustSources, join(stage, 'trust-gate'))
  else {
    for (const source of TRUST_GATE_FALLBACK_PATHS) copyIfPresent(repo, source, join('trust-gate', source), stage)
    writeJson(join(stage, 'trust-gate', 'STATUS.json'), { schemaVersion: 1, status: 'SOURCE_SNAPSHOTS_ONLY' })
  }

  if (evidenceRoots.verification && existsSync(evidenceRoots.verification)) copyTree(evidenceRoots.verification, join(stage, 'verification'))
  else writeJson(join(stage, 'verification', 'STATUS.json'), { schemaVersion: 1, status: 'NOT_SUPPLIED' })
  if (evidenceRoots.cleanup && existsSync(evidenceRoots.cleanup)) copyTree(evidenceRoots.cleanup, join(stage, 'cleanup'))
  else writeJson(join(stage, 'cleanup', 'STATUS.json'), { schemaVersion: 1, status: 'NOT_SUPPLIED' })
  if (evidenceRoots.live && existsSync(evidenceRoots.live)) copyTree(evidenceRoots.live, join(stage, 'live-eval'))
  else writeJson(join(stage, 'live-eval', 'STATUS.json'), {
    schemaVersion: 1,
    status: 'NOT_RUN',
    requestedModels: ['DeepSeek Flash', 'GLM 5.3 Flash'],
    resolvedModelIds: [models.deepseek, models.glm].every((value) => !value.startsWith('NOT_RESOLVED'))
      ? [models.deepseek, models.glm]
      : [],
  })
  if (evidenceRoots.intentionalDuplicates && existsSync(evidenceRoots.intentionalDuplicates)) copyFile(evidenceRoots.intentionalDuplicates, join(stage, 'intentional-duplicates.json'))

  writeText(join(stage, 'FINAL_REPORT.md'), makeReport({ head, originMain, branch, verificationStatus, cleanupStatus, liveStatus, verdict, models }))
  writeJson(join(stage, 'PACKAGE_INFO.json'), {
    schemaVersion: 1,
    packageSchema: PACKAGE_SCHEMA,
    createdAt: new Date().toISOString(),
    finalMainSha: originMain,
    localHeadSha: head,
    verdict,
    requestedModels: ['DeepSeek Flash', 'GLM 5.3 Flash'],
    resolvedModelIds: [models.deepseek, models.glm].every((value) => !value.startsWith('NOT_RESOLVED'))
      ? [models.deepseek, models.glm]
      : [],
  })

  const manifest = createManifest(stage, {
    finalMainSha: originMain,
    sourceCommit: /^[a-f0-9]{40}$/i.test(head) ? head : null,
  })
  writeJson(join(stage, 'MANIFEST.json'), manifest)
  const directoryResult = validateDirectory(stage)
  if (directoryResult.status !== 'PASS') {
    throw new Error(`semantic package validation failed: ${JSON.stringify(directoryResult)}`)
  }
  zipDirectory(stage, output)
  const archiveResult = validatePackageInput(output)
  if (archiveResult.status !== 'PASS') {
    throw new Error(`ZIP extraction/reverification failed: ${JSON.stringify(archiveResult)}`)
  }
  process.stdout.write(`${JSON.stringify({
    status: 'PACKAGE_VALIDATED',
    output,
    zip_sha256: sha256(readFileSync(output)),
    manifest_file_count: archiveResult.manifest_file_count,
    semantic_validation: archiveResult.semantic_validation,
    duplicate_validation: archiveResult.duplicate_validation,
    secret_scan: archiveResult.secret_scan,
    extraction_reverification: archiveResult.extraction_reverification,
  }, null, 2)}\n`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
