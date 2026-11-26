import { parse, type AnyNode, type CallExpression, type ImportDeclaration } from 'acorn'
import { posix } from 'node:path'
import { parseStructuredVerifierCommand } from './completionGatePolicy.js'
import type { TaskBehaviorPoint } from './taskBehaviorPoint.js'
import { readVerifierCommandInput, verifierCommandInputFiles, type VerifierCommandInputOverrides } from './verifierCommandInputs.js'

function strictTestCommand(projectRoot: string, command: string, fs: VerifierCommandInputOverrides): string | undefined {
  const npmScript = /^npm\s+(?:run\s+)?([\w:.-]+)$/.exec(command)
  if (!npmScript) return command
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
export function hasPointVerifierWitness(
  projectRoot: string,
  command: string,
  point: TaskBehaviorPoint,
  fs: VerifierCommandInputOverrides,
): boolean {
  const entry = strictTestCommand(projectRoot, command, fs)
  if (!entry) return false
  const parsed = parseStructuredVerifierCommand(entry)
  if (parsed?.executable !== 'node' || parsed.args.length !== 2 || parsed.args[0] !== '--test') return false
  const testPath = parsed.args[1]!.replace(/^\.\//, '')
  if (!/^[\w./-]+\.[cm]?js$/.test(testPath)) return false
  const files = verifierCommandInputFiles(projectRoot, entry, fs)
  if (!files.includes(testPath)) return false
  const content = readVerifierCommandInput(projectRoot, testPath, fs)
  if (content === null || content.length > 256_000) return false
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
        specifier.imported.name === point.symbol ? [specifier.local.name] : [],
      )
    })
    if (importedTargets.length !== 1) return false

    let matched = false
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration' || node.type === 'EmptyStatement') continue
      if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression' ||
        !testNames.includes(calledName(node.expression) ?? '')) return false
      const assertion = simpleAssertion(node.expression)
      if (!assertion || assertion.callee.type !== 'MemberExpression' ||
        assertion.callee.computed || assertion.callee.optional ||
        assertion.callee.object.type !== 'Identifier' || !assertNames.includes(assertion.callee.object.name) ||
        assertion.callee.property.type !== 'Identifier' ||
        !['equal', 'strictEqual'].includes(assertion.callee.property.name)) return false
      const [actual, expected] = assertion.arguments
      if (assertion.arguments.length === 2 && actual?.type === 'CallExpression' &&
        calledName(actual) === importedTargets[0] &&
        actual.arguments.length === point.args.length &&
        point.args.every((value, index) => Object.is(value, numericLiteral(actual.arguments[index]))) &&
        Object.is(point.expected, numericLiteral(expected))) matched = true
    }
    return matched
  } catch {
    return false
  }
}
