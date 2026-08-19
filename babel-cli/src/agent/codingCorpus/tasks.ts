/**
 * Frozen 40-task coding corpus. Each cell is human-authored (not imported
 * from a public benchmark dump). Synthetic fixture repos live under
 * fixtures/repos; Babel dogfood tasks pin this repository.
 */

import { createHash } from 'node:crypto'
import type { CodingCorpusTask, TaskClass, TaskRisk } from './types.js'

const BABEL_REPO = 'gthgomez/Babel'
const FIXTURE_ROOT = 'babel-cli/src/agent/codingCorpus/fixtures/repos'
const VALIDATOR = 'coding-loop-hardening-author'
const HEAD_PIN = '50b1d04f99746f83eda20ddb922826ac5f6bcec7'

interface Spec {
  id: string
  cls: TaskClass
  risk: TaskRisk
  lang: string
  prompt: string
  files: string[]
  forbidden: string[]
  visible: string[]
  hidden: string[]
  baseline: string[]
  win?: boolean
  note: string
  repo?: string
  commit?: string
}

const SPECS: Spec[] = [
  // 6 simple single-file bugs
  s('sf-01', 'single_file_bug', 'low', 'ts', 'Fix add() which subtracts instead of adding.', ['src/add.ts'], ['package.json'], ['npm test -- add'], ['hidden: add(2,2)===4'], [], 'operator typo'),
  s('sf-02', 'single_file_bug', 'low', 'py', 'Fix off-by-one in clamp().', ['clamp.py'], [], ['pytest'], ['hidden: clamp(10,0,5)==5'], [], 'index error'),
  s('sf-03', 'single_file_bug', 'low', 'go', 'Fix reversed comparison in Max().', ['max.go'], ['go.mod'], ['go test'], ['hidden: Max(-1,-2)==-1'], [], 'comparator'),
  s('sf-04', 'single_file_bug', 'low', 'rs', 'Fix integer overflow in saturating add helper.', ['src/lib.rs'], ['Cargo.toml'], ['cargo test'], ['hidden: saturating_add(u32::MAX,1)'], [], 'overflow'),
  s('sf-05', 'single_file_bug', 'low', 'ts', 'Windows path join uses / on win32; use path.join.', ['src/paths.ts'], [], ['npx tsx --test'], ['hidden: win32 join'], ['package-lock.json'], true, 'path sep'),
  s('sf-06', 'single_file_bug', 'low', 'js', 'JSON parse helper swallows SyntaxError; surface it.', ['parse.js'], [], ['node --test'], ['hidden: invalid json throws'], [], 'error swallow'),
  // 7 medium 2-4 file bugs
  s('md-01', 'medium_bug', 'medium', 'ts', 'Cache invalidation misses rename; fix store + tests.', ['src/cache.ts', 'src/store.ts'], ['tsconfig.json'], ['npm test'], ['hidden: rename evicts'], [], 'cache'),
  s('md-02', 'medium_bug', 'medium', 'py', 'CSV reader mishandles quoted commas across reader/writer.', ['reader.py', 'writer.py'], [], ['pytest'], ['hidden: quoted comma'], [], 'csv'),
  s('md-03', 'medium_bug', 'medium', 'ts', 'Retry helper and client disagree on idempotency key.', ['src/retry.ts', 'src/client.ts'], [], ['npm test'], ['hidden: same key reused'], [], 'idempotency'),
  s('md-04', 'medium_bug', 'medium', 'go', 'HTTP handler and middleware drop X-Request-Id.', ['handler.go', 'mw.go'], [], ['go test'], ['hidden: header roundtrip'], [], 'header'),
  s('md-05', 'medium_bug', 'medium', 'ts', 'CRLF files get converted to LF by formatter hook.', ['src/format.ts', 'src/write.ts'], [], ['npm test'], ['hidden: crlf preserved'], ['package.json'], true, 'newline'),
  s('md-06', 'medium_bug', 'medium', 'py', 'Timezone helper and scheduler drift by one hour DST.', ['tz.py', 'sched.py'], [], ['pytest'], ['hidden: dst spring'], [], 'dst'),
  s('md-07', 'medium_bug', 'medium', 'ts', 'Search index and watcher skip deleted files.', ['src/index.ts', 'src/watch.ts'], [], ['npm test'], ['hidden: delete removes hit'], [], 'index'),
  // 5 multi-file features
  s('ft-01', 'multi_file_feature', 'medium', 'ts', 'Add tagged logging: logger, formatter, config.', ['src/log.ts', 'src/format.ts', 'src/config.ts'], ['LICENSE'], ['npm test'], ['hidden: tag in json'], [], 'feature'),
  s('ft-02', 'multi_file_feature', 'medium', 'py', 'Add paginated list API + tests + CLI flag.', ['api.py', 'cli.py', 'test_api.py'], [], ['pytest'], ['hidden: page=2'], [], 'pagination'),
  s('ft-03', 'multi_file_feature', 'high', 'ts', 'Add workspace ignore rules honored by search and grep.', ['src/ignore.ts', 'src/search.ts'], ['.git'], ['npm test'], ['hidden: ignored file omitted'], [], 'ignore'),
  s('ft-04', 'multi_file_feature', 'medium', 'go', 'Add healthz + readyz endpoints with shared auth.', ['health.go', 'auth.go', 'main.go'], [], ['go test'], ['hidden: ready 503'], [], 'health'),
  s('ft-05', 'multi_file_feature', 'medium', 'ts', 'Add PowerShell-safe quote helper used by shell runner.', ['src/quote.ts', 'src/shell.ts'], [], ['npm test'], ['hidden: quote $HOME'], ['README.md'], true, 'quoting'),
  // 4 refactors
  s('rf-01', 'behavior_preserving_refactor', 'medium', 'ts', 'Extract parseArgs without changing CLI behavior.', ['src/cli.ts', 'src/args.ts'], ['package.json'], ['npm test'], ['hidden: --help text identical'], [], 'extract'),
  s('rf-02', 'behavior_preserving_refactor', 'medium', 'py', 'Split god-module utils.py into io/text without API break.', ['utils.py', 'io.py', 'text.py'], [], ['pytest'], ['hidden: public imports'], [], 'split'),
  s('rf-03', 'behavior_preserving_refactor', 'low', 'ts', 'Rename internal helper; keep exported names.', ['src/internal.ts'], ['src/index.ts'], ['npm test'], ['hidden: export map'], [], 'rename'),
  s('rf-04', 'behavior_preserving_refactor', 'medium', 'go', 'Move types to types.go; tests must still pass.', ['types.go', 'lib.go'], [], ['go test'], ['hidden: golden'], [], 'move'),
  // 4 failing-test-provided repairs
  s('tr-01', 'failing_test_repair', 'low', 'ts', 'Red test expects unique IDs; implement generator.', ['src/id.ts', 'src/id.test.ts'], [], ['npm test -- id.test.ts'], ['hidden: 1000 unique'], [], 'red test'),
  s('tr-02', 'failing_test_repair', 'low', 'py', 'Red test for palindrome unicode; implement.', ['pal.py', 'test_pal.py'], [], ['pytest'], ['hidden: combining marks'], [], 'unicode'),
  s('tr-03', 'failing_test_repair', 'medium', 'ts', 'Red test for stale cache after write; fix cache.', ['src/cache.ts', 'src/cache.test.ts'], [], ['npm test'], ['hidden: write busts'], [], 'stale'),
  s('tr-04', 'failing_test_repair', 'low', 'rs', 'Red cargo test for wrap; implement wrapping add.', ['src/lib.rs'], [], ['cargo test'], ['hidden: wrap 255+1'], [], 'wrap'),
  // 3 unfamiliar repos
  s('uf-01', 'unfamiliar_repo', 'medium', 'c', 'Tiny C hash map leaks on overwrite; fix.', ['map.c'], ['Makefile'], ['make test'], ['hidden: asan overwrite'], [], 'unfamiliar C', `${FIXTURE_ROOT}/tiny-hmap`, 'fixture:v0'),
  s('uf-02', 'unfamiliar_repo', 'medium', 'java', 'Mini invoice tax rounding is half-up vs half-even.', ['Invoice.java'], ['pom.xml'], ['mvn test'], ['hidden: 0.5 even'], [], 'unfamiliar Java', `${FIXTURE_ROOT}/invoice`, 'fixture:v0'),
  s('uf-03', 'unfamiliar_repo', 'medium', 'rb', 'Tiny ERB-like renderer double-escapes.', ['render.rb'], [], ['ruby test.rb'], ['hidden: already escaped'], [], 'unfamiliar Ruby', `${FIXTURE_ROOT}/erbish`, 'fixture:v0'),
  // 3 API/contract
  s('ap-01', 'api_contract', 'high', 'ts', 'Widen User.id from number to string; update types and callers.', ['src/user.ts', 'src/api.ts'], ['package-lock.json'], ['npx tsc --noEmit && npm test'], ['hidden: id "42"'], [], 'contract'),
  s('ap-02', 'api_contract', 'medium', 'py', 'Change /v1/items to return {items,next}; update client.', ['server.py', 'client.py'], [], ['pytest'], ['hidden: next token'], [], 'pagination contract'),
  s('ap-03', 'api_contract', 'high', 'ts', 'Error shape must be {code,message}; stop throwing strings.', ['src/errors.ts', 'src/http.ts'], [], ['npm test'], ['hidden: code=NOT_FOUND'], [], 'errors'),
  // 3 dependency/config/build
  s('cf-01', 'dependency_config_build', 'high', 'ts', 'Fix tsconfig rootDir so build emits dist/index.js.', ['tsconfig.json'], ['src/index.ts'], ['npx tsc --noEmit && npm run build'], ['hidden: dist exists'], [], 'tsconfig'),
  s('cf-02', 'dependency_config_build', 'medium', 'js', 'package.json test script points at missing runner; fix.', ['package.json'], ['src/'], ['npm test'], ['hidden: exit 0'], [], 'script'),
  s('cf-03', 'dependency_config_build', 'high', 'ts', 'Peer dep version range excludes working typescript; relax.', ['package.json'], ['src/'], ['npm test'], ['hidden: tsc 5.4'], [], 'peerdep'),
  // 3 regression / shared workspace
  s('rg-01', 'regression_shared_workspace', 'high', 'ts', 'Fix shared formatter used by two packages; do not break pkg-b.', ['packages/a/src/fmt.ts', 'packages/b/src/use.ts'], ['packages/b/package.json'], ['npm test -w b'], ['hidden: pkg-b snapshot'], [], 'shared'),
  s('rg-02', 'regression_shared_workspace', 'medium', 'py', 'Shared util change broke batch job; restore both.', ['util.py', 'job.py'], [], ['pytest'], ['hidden: batch 3'], [], 'shared py'),
  s('rg-03', 'regression_shared_workspace', 'high', 'ts', 'Windows path cache keys collide on case; isolate keys.', ['src/cache.ts', 'src/fs.ts'], [], ['npm test'], ['hidden: A.ts vs a.ts'], ['yarn.lock'], true, 'case'),
  // 2 extra to reach 40 — Babel dogfood
  {
    id: 'df-01',
    cls: 'medium_bug',
    risk: 'high',
    lang: 'ts',
    prompt:
      'In babel-cli, a later read_range of an unchanged file must return the requested window even if a prior read_file hashed equal. Implement and test.',
    files: ['babel-cli/src/agent/codingLoop/readWindow.ts', 'babel-cli/src/agent/chatEngine.ts'],
    forbidden: ['prompt_catalog.yaml', '00_System_Router/OLS-v9-Orchestrator.md'],
    visible: ['cd babel-cli && npx tsx --test src/agent/codingLoop/readWindow.test.ts'],
    hidden: ['range 200-250 served after full read of same hash'],
    baseline: ['read_range skipped via path-hash cache'],
    note: 'Babel dogfood: P0-A range-read',
    repo: BABEL_REPO,
    commit: HEAD_PIN,
    win: true,
  },
  {
    id: 'df-02',
    cls: 'medium_bug',
    risk: 'high',
    lang: 'ts',
    prompt:
      'After a successful chat write, a red verifier must reopen read/search/LSP so the model can inspect the failing test before a second repair.',
    files: ['babel-cli/src/agent/codingLoop/postWritePolicy.ts', 'babel-cli/src/agent/chatEngine.ts'],
    forbidden: ['babel-cli/src/bridge/'],
    visible: ['cd babel-cli && npx tsx --test src/agent/codingLoop/postWritePolicy.test.ts'],
    hidden: ['investigation tools present after red verifier in general_swe'],
    baseline: ['sticky act_or_verify after first write'],
    note: 'Babel dogfood: P0-C lockout',
    repo: BABEL_REPO,
    commit: HEAD_PIN,
  },
]

function s(
  id: string,
  cls: TaskClass,
  risk: TaskRisk,
  lang: string,
  prompt: string,
  files: string[],
  forbidden: string[],
  visible: string[],
  hidden: string[],
  baseline: string[],
  note: string,
  repo?: string,
  commit?: string,
): Spec
function s(
  id: string,
  cls: TaskClass,
  risk: TaskRisk,
  lang: string,
  prompt: string,
  files: string[],
  forbidden: string[],
  visible: string[],
  hidden: string[],
  baseline: string[],
  win: boolean,
  note: string,
): Spec
function s(...args: unknown[]): Spec {
  if (typeof args[10] === 'boolean') {
    const [id, cls, risk, lang, prompt, files, forbidden, visible, hidden, baseline, win, note] =
      args as [string, TaskClass, TaskRisk, string, string, string[], string[], string[], string[], string[], boolean, string]
    return { id, cls, risk, lang, prompt, files, forbidden, visible, hidden, baseline, win, note }
  }
  const [id, cls, risk, lang, prompt, files, forbidden, visible, hidden, baseline, note, repo, commit] =
    args as [string, TaskClass, TaskRisk, string, string, string[], string[], string[], string[], string[], string, string?, string?]
  return {
    id,
    cls,
    risk,
    lang,
    prompt,
    files,
    forbidden,
    visible,
    hidden,
    baseline,
    note,
    ...(repo ? { repo } : {}),
    ...(commit ? { commit } : {}),
  }
}

function fixtureCommit(id: string): string {
  return `fixture:${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

function toTask(spec: Spec): CodingCorpusTask {
  const repo = spec.repo ?? `${FIXTURE_ROOT}/${spec.id}`
  const commit = spec.commit ?? fixtureCommit(spec.id)
  return {
    id: spec.id,
    repository: repo,
    starting_commit: commit,
    task_prompt: spec.prompt,
    task_class: spec.cls,
    risk: spec.risk,
    visible_checks: spec.visible,
    hidden_acceptance: spec.hidden,
    known_baseline_failures: spec.baseline,
    max_cost_usd: spec.risk === 'high' ? 2.5 : spec.risk === 'medium' ? 1.5 : 0.8,
    max_turns: spec.risk === 'high' ? 40 : 24,
    max_wall_s: spec.risk === 'high' ? 600 : 300,
    expected_files: spec.files,
    forbidden_changes: spec.forbidden,
    language: spec.lang,
    ...(spec.win ? { windows_relevant: true } : {}),
    validated_by: VALIDATOR,
    validation_note: spec.note,
  }
}

const TASKS: CodingCorpusTask[] = SPECS.map(toTask)

/**
 * Frozen corpus inventory. Count is part of the Wave-0 contract (36–40).
 */
export function listCodingCorpusTasks(): CodingCorpusTask[] {
  return TASKS.slice()
}

export function getCodingCorpusTask(id: string): CodingCorpusTask | undefined {
  return TASKS.find((t) => t.id === id)
}

export function codingCorpusInventory(): {
  version: string
  count: number
  byClass: Record<string, number>
  ids: string[]
} {
  const byClass: Record<string, number> = {}
  for (const t of TASKS) {
    byClass[t.task_class] = (byClass[t.task_class] ?? 0) + 1
  }
  return {
    version: 'coding-corpus-v0',
    count: TASKS.length,
    byClass,
    ids: TASKS.map((t) => t.id),
  }
}
