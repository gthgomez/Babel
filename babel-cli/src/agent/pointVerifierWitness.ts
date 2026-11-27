import { parse, type AnyNode, type CallExpression, type ImportDeclaration } from 'acorn'
import { existsSync, lstatSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import { discoverVerifierInputClosure } from '../evidence/revisionBoundReceipt.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import { verifierExecutionFingerprint } from '../services/verifierIdentity.js'
import { parseStructuredVerifierCommand } from './completionGatePolicy.js'
import type { TaskBehaviorPoint } from './taskBehaviorPoint.js'
import { readVerifierCommandInput, verifierCommandInputFiles, type VerifierCommandInputOverrides } from './verifierCommandInputs.js'

function strictTestCommand(projectRoot: string, command: string, fs: VerifierCommandInputOverrides): string | undefined {
  const npmScript = /^npm\s+(?:run\s+)?([\w:.-]+)$/.exec(command)
  if (!npmScript) return command
  if ((fs.exists ?? existsSync)(join(projectRoot, '.npmrc'))) return undefined
  try {
    if (!fs.readFile && !lstatSync(join(projectRoot, 'package.json')).isFile()) return undefined
    const packageText = readVerifierCommandInput(projectRoot, 'package.json', fs)
    if (!packageText) return undefined
    const scripts = (JSON.parse(packageText) as { scripts?: Record<string, unknown> }).scripts
    const name = npmScript[1]!
    if (!scripts || Object.hasOwn(scripts, `pre${name}`) || Object.hasOwn(scripts, `post${name}`)) return undefined
    const script = scripts[name]
    // npm runs through the platform shell. Single quotes do not group argv
    // in the Windows default shell, even though the structured parser accepts them.
    return typeof script === 'string' && !script.includes("'") ? script.trim() : undefined
  } catch {
    return undefined
  }
}

const LEGACY_POINT_TARGET_PREFIX = 'node-test-point:v1:'
export const POINT_TARGET_PREFIX = 'node-test-point:v2:'

export function pointVerifierInputRefPrefix(command: string): string {
  return `babel:point-verifier-inputs:v1:${sha256Canonical(command.trim())}:`
}

type PointVerifierInput = { entry: string; testPath: string; checkDigest: string }
export type PointVerifierCase = PointVerifierInput & { test: string }
export type ExecutedPointClaim = Pick<PointVerifierWitness, 'target' | 'case' | 'modulePath' | 'point'>
type PointValue = number | '-0'
type JournalPoint = Omit<TaskBehaviorPoint, 'args' | 'expected'> & {
  modulePath?: string
  args: PointValue[]
  expected: PointValue
}

function journalPoint(point: JournalPoint): JournalPoint {
  const retainSign = (value: PointValue) => Object.is(value, -0) ? '-0' : value
  return { ...point, args: point.args.map(retainSign), expected: retainSign(point.expected) }
}

function nodeTestPath(entry: string): string | undefined {
  const parsed = parseStructuredVerifierCommand(entry)
  if (parsed?.executable === 'node' && parsed.args.length === 2 && parsed.args[0] === '--test')
    return parsed.args[1]!.replace(/^\.\//, '')
}

/** Bind a frozen test case to one exact behavioral point. */
export function pointTargetForCase(
  test: PointVerifierCase, path: string, point: JournalPoint,
): string {
  return POINT_TARGET_PREFIX + sha256Canonical({ ...test, path, point: journalPoint(point) })
}

/** Commit the exact runner entry and test bytes independently of the case requested later. */
export function pointVerifierCaseInputDigest(input: PointVerifierInput): string {
  return sha256Canonical({ entry: input.entry, testPath: input.testPath, checkDigest: input.checkDigest })
}

export function pointVerifierCaseRef(inputRef: string, target: string): string {
  return `${inputRef}:${sha256Canonical(target)}`
}

/** Freeze protected Node test inputs and let admission prove a case against those same bytes. */
export function snapshotPointVerifierInputs(
  root: string, command: string, protectedPaths: ReadonlySet<string>,
): { ref: string; caseRefs: string[]; fs: VerifierCommandInputOverrides } | undefined {
  const contents = new Map<string, string | null>()
  const fs: VerifierCommandInputOverrides = { readFile: absolute => {
    if (!contents.has(absolute)) {
      const path = relative(root, absolute).replaceAll('\\', '/')
      let content: string | null = null
      if (protectedPaths.has(path)) {
        try {
          const stat = lstatSync(absolute)
          if (stat.isFile() && stat.size <= 256_000) content = readVerifierCommandInput(root, path)
        } catch { /* An unproved input cannot establish a binding. */ }
      }
      contents.set(absolute, content)
    }
    return contents.get(absolute) ?? null
  } }
  const entry = strictTestCommand(root, command, fs)
  if (!entry) return
  const testPath = nodeTestPath(entry)
  if (!testPath) return
  if (!verifierCommandInputFiles(root, entry).includes(testPath)) return
  const paths = (command !== entry || protectedPaths.has('package.json')) ? [testPath, 'package.json'] : [testPath]
  const inputs: Record<string, string> = {}
  for (const path of paths) {
    const content = readVerifierCommandInput(root, path, fs)
    if (content === null || content.length > 256_000) return
    inputs[path] = sha256Canonical(content)
  }
  const inputDigest = pointVerifierCaseInputDigest({ entry, testPath, checkDigest: inputs[testPath]! })
  const ref = `${pointVerifierInputRefPrefix(command)}${inputDigest}:${sha256Canonical(inputs)}`
  try {
    const ast = parse(readVerifierCommandInput(root, testPath, fs)!, { ecmaVersion: 'latest', sourceType: 'module' })
    if (ast.body.length > 128) return
    const imports = new Map<string, { modulePath: string; symbol: string }>()
    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration' || typeof node.source.value !== 'string' || !node.source.value.startsWith('.')) continue
      const modulePath = posix.normalize(posix.join(posix.dirname(testPath), node.source.value))
      for (const item of node.specifiers) {
        if (item.type === 'ImportSpecifier' && item.imported.type === 'Identifier')
          imports.set(item.local.name, { modulePath, symbol: item.imported.name })
      }
    }
    const caseRefs = ast.body.flatMap(node => {
      if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression') return []
      const [call, result] = simpleAssertion(node.expression)?.arguments ?? []
      if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') return []
      const imported = imports.get(call.callee.name)
      const expected = numericLiteral(result)
      const args = call.arguments.map(numericLiteral)
      if (!imported || expected === undefined || !args.every((arg): arg is number => arg !== undefined)) return []
      const witness = pointVerifierWitness(root, command, { ...imported, args, expected }, fs)
      return witness ? [pointVerifierCaseRef(ref, witness.target)] : []
    })
    return { ref, caseRefs: [...new Set(caseRefs)], fs }
  } catch { return }
}

/** Retained objectives keep their original point identity until resubmitted. */
export function isLegacyPointTarget(target: string | undefined): boolean {
  return target?.startsWith(LEGACY_POINT_TARGET_PREFIX) ?? false
}

export interface PointVerifierWitness {
  target: string
  case: PointVerifierCase
  modulePath: string
  point: JournalPoint
  entry: string
  npmScript: boolean
  testNames: string[]
}

function matchesDeclaredEntry(projectRoot: string, target: string, fs: VerifierCommandInputOverrides): boolean {
  const manifest = readVerifierCommandInput(projectRoot, 'package.json', fs)
  if (manifest === null) return !(fs.exists ?? existsSync)(join(projectRoot, 'package.json'))
  const { main, exports } = JSON.parse(manifest) as { main?: unknown; exports?: unknown }
  if (main === undefined && exports === undefined) return true
  // A package can expose different entries by condition or subpath. Without an
  // explicit task path, do not guess which of those entries is the objective.
  const entry = exports ?? main
  return typeof entry === 'string' && posix.normalize(entry) === target
}

function uniquelyNamedTarget(
  projectRoot: string,
  testPath: string,
  targetPath: string,
  symbol: string,
  fs: VerifierCommandInputOverrides,
): boolean {
  const closure = discoverVerifierInputClosure(projectRoot)
  if (closure.mode !== 'bound' || !closure.paths.includes(targetPath) ||
    !matchesDeclaredEntry(projectRoot, targetPath, fs)) return false
  for (const path of closure.paths) {
    if (path === testPath || path === targetPath || !/\.[cm]?[jt]sx?$/i.test(path)) continue
    const source = readVerifierCommandInput(projectRoot, path, fs)
    if (source === null || source.includes(symbol)) return false
  }
  return true
}

function numericLiteral(node: AnyNode | undefined): number | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value
  if (node?.type === 'UnaryExpression' && node.operator === '-' &&
    node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value
  return undefined
}

function calledName(call: CallExpression): string | undefined {
  return !call.optional && call.callee.type === 'Identifier' ? call.callee.name : undefined
}

function defaultImports(imports: ImportDeclaration[], module: string): string[] {
  return imports.filter(item => item.source.value === module).flatMap(item =>
    item.specifiers.filter(specifier => specifier.type === 'ImportDefaultSpecifier').map(specifier => specifier.local.name),
  )
}

function simpleAssertion(test: CallExpression): CallExpression | undefined {
  const [name, callback] = test.arguments
  if (test.arguments.length !== 2 || name?.type !== 'Literal' || typeof name.value !== 'string') return undefined
  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') return undefined
  if (callback.params.length || (callback.type === 'FunctionExpression' && (callback.generator || callback.id))) return undefined
  const expression = callback.body.type !== 'BlockStatement' ? callback.body
    : callback.body.body.length === 1 && callback.body.body[0]?.type === 'ExpressionStatement'
      ? callback.body.body[0].expression : undefined
  return expression?.type === 'CallExpression' && !expression.optional ? expression : undefined
}

/**
 * Recognize a direct numeric assertion in a fixed, pre-existing Node test entry.
 * Unsupported runners, hooks, selection flags and dynamic test registration do
 * not prove a point. The existing governed receipt still decides pass/fail.
 */
export function pointVerifierWitness(
  projectRoot: string,
  command: string,
  point: TaskBehaviorPoint & { modulePath?: string },
  fs: VerifierCommandInputOverrides,
): PointVerifierWitness | undefined {
  const entry = strictTestCommand(projectRoot, command, fs)
  if (!entry) return undefined
  const testPath = nodeTestPath(entry)
  if (!testPath || !/^[\w ./-]+\.[cm]?js$/.test(testPath)) return undefined
  const files = verifierCommandInputFiles(projectRoot, entry, fs)
  if (!files.includes(testPath)) return undefined
  const content = readVerifierCommandInput(projectRoot, testPath, fs)
  if (content === null || content.length > 256_000) return undefined
  try {
    const ast = parse(content, { ecmaVersion: 'latest', sourceType: 'module' })
    const imports = ast.body.filter(node => node.type === 'ImportDeclaration')
    const testNames = [
      ...defaultImports(imports, 'node:test'),
      ...imports.filter(item => item.source.value === 'node:test').flatMap(item => item.specifiers.flatMap(specifier =>
        specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' &&
        ['test', 'it'].includes(specifier.imported.name) ? [specifier.local.name] : [],
      )),
    ]
    const assertNames = defaultImports(imports, 'node:assert/strict')
    const importedTargets = imports.flatMap(item => {
      const source = item.source.value
      if (typeof source !== 'string' || !/^\.{1,2}\/[\w./-]+\.[cm]?js$/.test(source)) return []
      const path = posix.normalize(posix.join(posix.dirname(testPath), source))
      if (path === testPath || !verifierCommandInputFiles(projectRoot, `node ${path}`, fs).includes(path)) return []
      return item.specifiers.flatMap(specifier =>
        specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' &&
        specifier.imported.name === point.symbol ? [{ binding: specifier.local.name, path }] : [],
      )
    })
    const importedTarget = importedTargets[0]
    if (importedTargets.length !== 1 || !importedTarget) return undefined
    if (point.modulePath ? importedTarget.path !== point.modulePath
      : !uniquelyNamedTarget(projectRoot, testPath, importedTarget.path, point.symbol, fs)) return undefined

    let witnessName: string | undefined
    const registeredNames = new Set<string>()
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration' || node.type === 'EmptyStatement') continue
      if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression' ||
        !testNames.includes(calledName(node.expression) ?? '')) return undefined
      const assertion = simpleAssertion(node.expression)
      if (!assertion || assertion.callee.type !== 'MemberExpression' ||
        assertion.callee.computed || assertion.callee.optional ||
        assertion.callee.object.type !== 'Identifier' || !assertNames.includes(assertion.callee.object.name) ||
        assertion.callee.property.type !== 'Identifier' ||
        !['equal', 'strictEqual'].includes(assertion.callee.property.name)) return undefined
      const name = node.expression.arguments[0]
      if (name?.type !== 'Literal' || typeof name.value !== 'string' || registeredNames.has(name.value) ||
        !/^[\p{L}\p{N} ._'-]{1,120}$/u.test(name.value) || name.value !== name.value.trim()) return undefined
      registeredNames.add(name.value)
      const [actual, expected] = assertion.arguments
      if (assertion.arguments.length === 2 && actual?.type === 'CallExpression' &&
        calledName(actual) === importedTarget.binding &&
        actual.arguments.length === point.args.length &&
        point.args.every((value, index) => Object.is(value, numericLiteral(actual.arguments[index]))) &&
        Object.is(point.expected, numericLiteral(expected))) {
        if (witnessName) return undefined
        witnessName = name.value
      }
    }
    if (!witnessName) return undefined
    const testCase = { entry, testPath, test: witnessName, checkDigest: sha256Canonical(content) }
    return {
      target: pointTargetForCase(testCase, importedTarget.path, point),
      case: testCase,
      modulePath: importedTarget.path,
      point: journalPoint(point),
      entry,
      npmScript: command !== entry,
      testNames: [...registeredNames],
    }
  } catch {
    return undefined
  }
}

/** Reconcile the complete runner report with the frozen registration, not an isolated stdout marker. */
export function nodePointExecuted(stdout: string, witness: Pick<PointVerifierWitness, 'entry' | 'npmScript' | 'testNames'>): boolean {
  const report = nodePointReport(stdout, witness.npmScript ? witness.entry : undefined)
  return report !== undefined && report.length === witness.testNames.length &&
    witness.testNames.every(name => report.includes(name))
}

/** Read only a complete passing runner report, retaining no arbitrary stdout. */
export function nodePointReport(stdout: string, npmEntry?: string): string[] | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(line => line.trim() !== '')
  if (npmEntry !== undefined) {
    if (!lines[0]?.startsWith('> ') || lines[1] !== `> ${npmEntry}`) return
    lines.splice(0, 2)
  }
  const isTap = lines[0] === 'TAP version 13'
  const prefix = isTap ? '#' : 'ℹ'
  const plan = lines.at(-8)
  const count = Number(new RegExp(`^${prefix} tests (\\d+)$`).exec(plan ?? '')?.[1])
  if (!Number.isSafeInteger(count) || count < 1 || count > 1024) return
  const footer = [
    ...(isTap ? [`1..${count}`] : []),
    `${prefix} tests ${count}`, `${prefix} suites 0`, `${prefix} pass ${count}`,
    ...['fail', 'cancelled', 'skipped', 'todo'].map(label => `${prefix} ${label} 0`),
  ]
  if (!/^(?:#|ℹ) duration_ms \d+(?:\.\d+)?$/.test(lines.at(-1) ?? '') ||
      !lines.at(-1)?.startsWith(prefix)) return
  const summary = lines.slice(-footer.length - 1, -1)
  if (summary.length !== footer.length || summary.some((line, index) => line !== footer[index])) return

  const caseRows = lines.slice(isTap ? 1 : 0, -footer.length - 1)
  const results = caseRows.flatMap(line => {
    if (isTap) return /^ok \d+ - (.+)$/.exec(line)?.[1] ?? []
    return /^✔ (.+) \(\d+(?:\.\d+)?ms\)$/.exec(line)?.[1] ?? []
  })
  // A second reporter or plan in the body is ambiguous, even if its rows look green.
  if (caseRows.some(line => /^TAP version |^\d+\.\.\d+|^(?:#|ℹ) (?:tests|pass|fail) \d+/.test(line))) return
  if (results.length === count && new Set(results).size === count) return results
}

/** Hash passing case names at the independent physical tool settlement boundary. */
export function settledNodePointReport(stdout: string): string[] | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(line => line.trim() !== '')
  const entry = lines[0]?.startsWith('> ') && lines[1]?.startsWith('> ') ? lines[1].slice(2) : undefined
  const npmEntry = entry && nodeTestPath(entry) ? entry : undefined
  return nodePointReport(stdout, npmEntry)?.map(name => sha256Canonical(name))
}

/** A later same-scope run without this case must not inherit an earlier case result. */
export function retainCurrentPointReceipts(receipts: readonly BoundChatVerifierReceipt[]): BoundChatVerifierReceipt[] {
  const currentReceipts = receipts.filter(receipt => {
    if (isLegacyPointTarget(receipt.target)) return false
    if (!receipt.target?.startsWith(POINT_TARGET_PREFIX)) return true
    const order = receipt.order
    const command = verifierExecutionFingerprint(receipt.command)
    if (!order || !command) return false
    return !receipts.some(other =>
      other.order?.sessionId === order.sessionId && other.order.seq > order.seq &&
      other.working_directory === receipt.working_directory && other.environment_policy === receipt.environment_policy &&
      other.executionContext?.environmentFingerprint === receipt.executionContext?.environmentFingerprint &&
      verifierExecutionFingerprint(other.command) === command,
    )
  })
  return currentReceipts.flatMap(receipt => {
    if (!receipt.target?.startsWith(POINT_TARGET_PREFIX) ||
        !Array.isArray(receipt.additionalPointTargets) || receipt.exit_code !== 0) return [receipt]
    // Only project cases after selecting the current physical attempt. The
    // event, disposition, execution context and revision remain the same.
    const targets = new Set(receipt.additionalPointTargets.filter(target =>
      typeof target === 'string' && target.startsWith(POINT_TARGET_PREFIX) &&
      /^[a-f0-9]{64}$/.test(target.slice(POINT_TARGET_PREFIX.length)),
    ))
    targets.delete(receipt.target)
    return [receipt, ...[...targets].map(target => ({ ...receipt, target }))]
  })
}
