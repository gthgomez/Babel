import { parse, type AnyNode, type Program, type CallExpression } from 'acorn'
import { posix } from 'node:path'
import { statSync } from 'node:fs'
import { recoveryTargetIdentity } from './recoveryIdentity.js'

export interface TestImportCandidate {
  path: string
  relation: string
  source: 'import_call'
  fromTestPath: string
}

function program(content: string): Program | null {
  if (content.length > 256_000) return null
  // Sandbox full reads carry sequential line numbers. Any header means the
  // lexical context is incomplete (line/byte cap or offset), so fail closed.
  if (/^\s*\d+│/.test(content)) {
    const lines = content.split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    const decoded: string[] = []
    for (const [index, line] of lines.entries()) {
      const match = /^\s*(\d+)│(.*)$/.exec(line)
      if (Number(match?.[1]) !== index + 1 || match?.[2] === undefined) return null
      decoded.push(match[2])
    }
    content = decoded.join('\n')
  }
  try { return parse(content, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) } catch { return null }
}

/** Bounded traversal of parser-produced syntax only; no regex fallback. */
function nodes(root: AnyNode): AnyNode[] {
  const result: AnyNode[] = []
  const queue: AnyNode[] = [root]
  while (queue.length && result.length < 20_000) {
    const next = queue.pop()!
    result.push(next)
    for (const value of Object.values(next)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item && typeof item === 'object' && typeof item.type === 'string' &&
            typeof item.start === 'number' && typeof item.end === 'number') queue.push(item as AnyNode)
      }
    }
  }
  return queue.length ? [] : result
}

/** Only a uniquely named Node test's assertion can propose its called static relative imports. */
export function proposeTestImports(input: {
  content: string; testPath: string; testName: string; projectRoot: string; line?: number; column?: number
}): TestImportCandidate[] {
  const ast = program(input.content)
  if (!ast || !/\.(?:test|spec)\.[cm]?js$/.test(input.testPath)) return []
  const moduleNodes = nodes(ast)
  if (!moduleNodes.length) return []
  const imports = ast.body.filter(n => n.type === 'ImportDeclaration')
  const testNames = new Set(imports.filter(n => n.source.value === 'node:test').flatMap(n =>
    n.specifiers.filter(s => s.type === 'ImportDefaultSpecifier' ||
      (s.type === 'ImportSpecifier' && s.imported.type === 'Identifier' && ['test', 'it'].includes(s.imported.name))).map(s => s.local.name)))
  const assertions = new Set(imports.filter(n => ['node:assert', 'node:assert/strict'].includes(String(n.source.value)))
    .flatMap(n => n.specifiers.filter(s => s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier' ||
      (s.type === 'ImportSpecifier' && s.imported.type === 'Identifier' && s.imported.name === 'strict')).map(s => s.local.name)))
  const matches = ast.body.flatMap(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' ? [n.expression] : [])
    .filter(n => n.callee.type === 'Identifier' && testNames.has(n.callee.name) &&
      n.arguments[0]?.type === 'Literal' && n.arguments[0].value === input.testName)
  if (matches.length !== 1) return []
  const callback = matches[0]!.arguments.at(-1)
  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') return []
  const syntax = nodes(callback)
  if (!syntax.length) return []
  // Conservative scope handling: nested callbacks and shadowed imports are unsupported.
  if (syntax.some(n => n !== callback && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(n.type))) return []
  const bindings = [...callback.params, ...(callback.type === 'FunctionExpression' && callback.id ? [callback.id] : []),
    ...syntax.flatMap(n => n.type === 'VariableDeclarator' ? [n.id] : n.type === 'CatchClause' && n.param ? [n.param] : [])]
  const shadowed = new Set(bindings.flatMap(n => nodes(n).filter(p => p.type === 'Identifier').map(p => p.name)))
  const importNames = new Set(imports.flatMap(n => n.specifiers.map(s => s.local.name)))
  // Assigning an imported binding cannot establish a reliable call relationship.
  if (moduleNodes.some(n => (n.type === 'AssignmentExpression' && nodes(n.left).some(p => p.type === 'Identifier' && importNames.has(p.name))) ||
      (n.type === 'UpdateExpression' && n.argument.type === 'Identifier' && importNames.has(n.argument.name)))) return []
  let assertionCalls = syntax.filter((n): n is CallExpression => n.type === 'CallExpression' &&
    n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' &&
    assertions.has(n.callee.object.name) && !shadowed.has(n.callee.object.name) &&
    n.callee.property.type === 'Identifier' && ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'ok', 'throws', 'rejects'].includes(n.callee.property.name))
  if (input.line !== undefined && input.column !== undefined) {
    const line = input.line, column = input.column - 1
    assertionCalls = assertionCalls.filter(n => n.loc &&
      (n.loc.start.line < line || (n.loc.start.line === line && n.loc.start.column <= column)) &&
      (n.loc.end.line > line || (n.loc.end.line === line && n.loc.end.column > column)))
  }
  // Without a unique diagnostic assertion, unrelated imports cannot become scope.
  if (assertionCalls.length !== 1) return []
  const called = new Set(assertionCalls.flatMap(n => n.arguments.flatMap(a => nodes(a)))
    .filter((n): n is CallExpression => n.type === 'CallExpression' && n.callee.type === 'Identifier')
    .map(n => n.callee.type === 'Identifier' ? n.callee.name : ''))
  const result: TestImportCandidate[] = []
  for (const declaration of imports) {
    const path = declaration.source.value
    if (typeof path !== 'string' || !path.startsWith('./') || path.split('/').includes('..') || !/\.[cm]?js$/.test(path)) continue
    const target = recoveryTargetIdentity(input.projectRoot, posix.join(posix.dirname(input.testPath), path))
    if (!target || target === input.testPath) continue
    try { if (!statSync(posix.join(input.projectRoot.replaceAll('\\', '/'), target)).isFile()) continue } catch { continue }
    for (const specifier of declaration.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.imported.type !== 'Identifier' ||
          shadowed.has(specifier.local.name) || !called.has(specifier.local.name)) continue
      result.push({ path: target, relation: specifier.imported.name, source: 'import_call', fromTestPath: input.testPath })
    }
  }
  const unique = [...new Map(result.map(n => [n.path + ':' + n.relation, n])).values()]
  return unique.length === 1 ? unique : []
}

/** A proposed import needs a fresh read of its actual exported function declaration. */
export function corroboratesTestImport(content: string, symbol: string): boolean {
  const ast = program(content)
  return ast?.body.some(n => n.type === 'ExportNamedDeclaration' && n.declaration &&
    ((n.declaration.type === 'FunctionDeclaration' && n.declaration.id?.name === symbol) ||
      (n.declaration.type === 'VariableDeclaration' && n.declaration.declarations.some(d => d.id.type === 'Identifier' &&
        d.id.name === symbol && (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression'))))) === true
}
