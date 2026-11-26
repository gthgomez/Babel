import { parse, type AnyNode, type CallExpression, type ImportDeclaration } from 'acorn'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { sha256Canonical } from '../acceptance/canonical.js'
import { discoverVerifierInputClosure } from '../evidence/revisionBoundReceipt.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import { parseStructuredVerifierCommand } from './completionGatePolicy.js'
import type { TaskBehaviorPoint } from './taskBehaviorPoint.js'
import { readVerifierCommandInput, verifierCommandInputFiles, type VerifierCommandInputOverrides } from './verifierCommandInputs.js'

function strictTestCommand(projectRoot: string, command: string, fs: VerifierCommandInputOverrides): string | undefined {
  const npmScript = /^npm\s+(?:run\s+)?([\w:.-]+)$/.exec(command)
  if (!npmScript) return command
  if ((fs.exists ?? existsSync)(join(projectRoot, '.npmrc'))) return undefined
  const packageText = readVerifierCommandInput(projectRoot, 'package.json', fs)
  if (!packageText) return undefined
  try {
    const scripts = (JSON.parse(packageText) as { scripts?: Record<string, unknown> }).scripts
    const name = npmScript[1]!
    if (!scripts || Object.hasOwn(scripts, `pre${name}`) || Object.hasOwn(scripts, `post${name}`)) return undefined
    const script = scripts[name]
    return typeof script === 'string' ? script.trim() : undefined
  } catch {
    return undefined
  }
}

export const POINT_TARGET_PREFIX = 'node-test-point:v1:'

interface PointVerifierWitness {
  target: string
  testName: string
}

function uniquelyNamedTarget(
  projectRoot: string,
  testPath: string,
  targetPath: string,
  symbol: string,
  fs: VerifierCommandInputOverrides,
): boolean {
  const closure = discoverVerifierInputClosure(projectRoot)
  if (closure.mode !== 'bound' || !closure.paths.includes(targetPath)) return false
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
  point: TaskBehaviorPoint,
  fs: VerifierCommandInputOverrides,
): PointVerifierWitness | undefined {
  const entry = strictTestCommand(projectRoot, command, fs)
  if (!entry) return undefined
  const parsed = parseStructuredVerifierCommand(entry)
  if (parsed?.executable !== 'node' || parsed.args.length !== 2 || parsed.args[0] !== '--test') return undefined
  const testPath = parsed.args[1]!.replace(/^\.\//, '')
  if (!/^[\w./-]+\.[cm]?js$/.test(testPath)) return undefined
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
    if (importedTargets.length !== 1 || !importedTarget ||
      !uniquelyNamedTarget(projectRoot, testPath, importedTarget.path, point.symbol, fs)) return undefined

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
      if (name?.type !== 'Literal' || typeof name.value !== 'string' || registeredNames.has(name.value)) return undefined
      registeredNames.add(name.value)
      const [actual, expected] = assertion.arguments
      if (assertion.arguments.length === 2 && actual?.type === 'CallExpression' &&
        calledName(actual) === importedTarget.binding &&
        actual.arguments.length === point.args.length &&
        point.args.every((value, index) => Object.is(value, numericLiteral(actual.arguments[index]))) &&
        Object.is(point.expected, numericLiteral(expected))) {
        if (witnessName || !/^[\p{L}\p{N} ._'-]{1,120}$/u.test(name.value) || name.value !== name.value.trim()) return undefined
        witnessName = name.value
      }
    }
    if (!witnessName) return undefined
    return {
      target: POINT_TARGET_PREFIX + sha256Canonical({
        testPath, test: witnessName, checkDigest: sha256Canonical(content), path: importedTarget.path, point,
      }),
      testName: witnessName,
    }
  } catch {
    return undefined
  }
}

/** A suite exit cannot establish a selected case was executed. Require its runner result. */
export function nodePointExecuted(stdout: string, testName: string): boolean {
  const lines = stdout.split(/\r?\n/)
  if (lines.includes('TAP version 13')) {
    const results = lines.map(line => /^(not )?ok \d+ - (.+)$/.exec(line)).filter(result => result !== null)
    const matching = results.filter(result => result[2] === testName)
    return matching.length === 1 && matching[0]?.[1] === undefined
  }
  // Supported Node versions also use the spec reporter by default. Its
  // result rows are interleaved with stdout, so reconcile the runner count.
  const totals = lines.flatMap(line => /^ℹ tests (\d+)$/.exec(line)?.[1] ?? [])
  const results = lines.map(line => /^([✔✖﹣]) (.+) \(\d+(?:\.\d+)?ms\)$/.exec(line)).filter(result => result !== null)
  const matching = results.filter(result => result[2] === testName)
  return totals.length === 1 && results.length === Number(totals[0]) &&
    matching.length === 1 && matching[0]?.[1] === '✔'
}

/** A later same-scope run without this case must not inherit an earlier case result. */
export function retainCurrentPointReceipts(receipts: readonly BoundChatVerifierReceipt[]): BoundChatVerifierReceipt[] {
  return receipts.filter(receipt => {
    if (!receipt.target?.startsWith(POINT_TARGET_PREFIX)) return true
    return !!receipt.order && !receipts.some(other =>
      other.order?.sessionId === receipt.order!.sessionId && other.order.seq > receipt.order!.seq &&
      other.working_directory === receipt.working_directory && other.environment_policy === receipt.environment_policy &&
      other.executionContext?.environmentFingerprint === receipt.executionContext?.environmentFingerprint &&
      other.command === receipt.command,
    )
  })
}
