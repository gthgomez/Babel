import { parse, type AnyNode, type Program, type CallExpression } from 'acorn'
import { posix } from 'node:path'
import { statSync } from 'node:fs'
import { recoveryTargetIdentity } from './recoveryIdentity.js'

export interface TestImportCandidate {
  path: string
  relation: string
  source: 'import_call' | 'file_read'
  fromTestPath: string
}

function completeRead(content: string): string | null {
  if (content.length > 256_000) return null
  if (/^\[Showing lines /m.test(content)) return null
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
  return content
}

function program(content: string): Program | null {
  const complete = completeRead(content)
  if (complete === null) return null
  try { return parse(complete, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) } catch { return null }
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
    n.callee.property.type === 'Identifier' && ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'ok', 'throws', 'rejects', 'match', 'doesNotMatch'].includes(n.callee.property.name))
  if (input.line !== undefined && input.column !== undefined) {
    const line = input.line, column = input.column - 1
    assertionCalls = assertionCalls.filter(n => n.loc &&
      (n.loc.start.line < line || (n.loc.start.line === line && n.loc.start.column <= column)) &&
      (n.loc.end.line > line || (n.loc.end.line === line && n.loc.end.column > column)))
  }
  // Without a unique diagnostic assertion, unrelated imports cannot become scope.
  if (assertionCalls.length !== 1) return []
  const assertion = assertionCalls[0]!
  if (assertion.arguments.some(a => a.type === 'SpreadElement')) return []
  const method = assertion.callee.type === 'MemberExpression' && assertion.callee.property.type === 'Identifier'
    ? assertion.callee.property.name : ''
  // Optional messages format diagnostics; they do not establish the assertion's
  // tested dependency. throws/rejects overload their second argument as a message.
  const operands = assertion.arguments.slice(0, ['ok', 'throws', 'rejects'].includes(method) ? 1 : 2)
  const assertionNodes = operands.flatMap(a => nodes(a))
  const called = new Set(assertionNodes
    .filter((n): n is CallExpression => n.type === 'CallExpression' && n.callee.type === 'Identifier')
    .map(n => n.callee.type === 'Identifier' ? n.callee.name : ''))
  const result: TestImportCandidate[] = []
  const fileReaders = new Set(imports.filter(n => n.source.value === 'node:fs').flatMap(n =>
    n.specifiers.filter(s => s.type === 'ImportSpecifier' && s.imported.type === 'Identifier' &&
      s.imported.name === 'readFileSync').map(s => s.local.name)))
  // Only the standard unshadowed URL constructor and a static, contained text
  // read in the failing assertion establish a data-file dependency.
  const urlShadowed = shadowed.has('URL') || importNames.has('URL') || moduleNodes.some(n =>
    (n.type === 'VariableDeclarator' && nodes(n.id).some(p => p.type === 'Identifier' && p.name === 'URL')) ||
    ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id?.name === 'URL') ||
    (n.type === 'AssignmentExpression' && nodes(n.left).some(p => p.type === 'Identifier' && p.name === 'URL')))
  if (!urlShadowed) for (const call of assertionNodes) {
    if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' ||
        !fileReaders.has(call.callee.name) || shadowed.has(call.callee.name) || call.arguments.length !== 2 ||
        call.arguments[1]?.type !== 'Literal' || !['utf8', 'utf-8'].includes(String(call.arguments[1].value))) continue
    const url = call.arguments[0]
    if (url?.type !== 'NewExpression' || url.callee.type !== 'Identifier' || url.callee.name !== 'URL' || url.arguments.length !== 2) continue
    const [literal, base] = url.arguments
    if (literal?.type !== 'Literal' || typeof literal.value !== 'string' ||
        !/^\.\/[A-Za-z0-9_./-]+$/.test(literal.value) || literal.value.split('/').includes('..') ||
        base?.type !== 'MemberExpression' || base.computed || base.property.type !== 'Identifier' || base.property.name !== 'url' ||
        base.object.type !== 'MetaProperty' || base.object.meta.name !== 'import' || base.object.property.name !== 'meta') continue
    const target = recoveryTargetIdentity(input.projectRoot, posix.join(posix.dirname(input.testPath), literal.value))
    if (!target || target === input.testPath) continue
    try { if (!statSync(posix.join(input.projectRoot.replaceAll('\\', '/'), target)).isFile()) continue } catch { continue }
    result.push({path: target, relation: 'readFileSync', source: 'file_read', fromTestPath: input.testPath})
  }
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
export function corroboratesTestImport(content: string, symbol: string, source: TestImportCandidate['source'] = 'import_call'): boolean {
  if (source === 'file_read') return completeRead(content) !== null
  const ast = program(content)
  return ast?.body.some(n => n.type === 'ExportNamedDeclaration' && n.declaration &&
    ((n.declaration.type === 'FunctionDeclaration' && n.declaration.id?.name === symbol) ||
      (n.declaration.type === 'VariableDeclaration' && n.declaration.declarations.some(d => d.id.type === 'Identifier' &&
        d.id.name === symbol && (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression'))))) === true
}
