import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../babel-cli/package.json', import.meta.url));
const ts = require('typescript');

/** Inspect executable host calls. Strings containing child programs are data,
 * not host exits; their lifecycle is covered by process-containment tests. */
export function inspectSource(source, path = 'source.ts') {
  path = path.replaceAll('\\', '/');
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error(`Cannot parse source for boundary inspection: ${path}`);
  const host = {
    getSourceFile: name => name === path ? sf : undefined,
    getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => '',
    getDirectories: () => [], fileExists: name => name === path,
    readFile: name => name === path ? source : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram([path], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  function moduleOf(node) {
    while (node && !ts.isImportDeclaration(node)) node = node.parent;
    return node?.moduleSpecifier?.text;
  }
  function access(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return access(node.expression, seen);
    if (ts.isPropertyAccessExpression(node)) {
      const base = access(node.expression, seen);
      return base && [...base, node.name.text];
    }
    if (ts.isElementAccessExpression(node)) {
      const base = access(node.expression, seen);
      return base && [...base, ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '*'];
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
          ts.isStringLiteralLike(node.arguments[0]) && ['node:process', 'process'].includes(node.arguments[0].text)) return ['process'];
      const callee = access(node.expression, seen);
      if (callee?.at(-1) === 'bind') return callee.slice(0, -1);
    }
    if (!ts.isIdentifier(node)) return null;
    const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
    if (node.text === 'process' && declarations.length === 0) return ['process'];
    if (node.text === 'globalThis' && declarations.length === 0) return [];
    for (const declaration of declarations) {
      if (['node:process', 'process'].includes(moduleOf(declaration))) {
        if (ts.isImportSpecifier(declaration)) return ['process', declaration.propertyName?.text ?? declaration.name.text];
        if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) return ['process'];
      }
      if (ts.isVariableDeclaration(declaration)) return access(declaration.initializer, seen);
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const base = access(declaration.parent.parent.initializer, seen);
        const key = declaration.propertyName ?? declaration.name;
        return base && [...base, ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '*'];
      }
    }
    return null;
  }
  const exits = [], stdout = [], ambiguous = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      let route = access(node.expression);
      if (['call', 'apply'].includes(route?.at(-1))) route = route.slice(0, -1);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (route?.join('.') === 'process.exit') exits.push(line);
      if (route?.join('.') === 'process.stdout.write') stdout.push(line);
      if (route?.[0] === 'process' && (route[1] === '*' || (route[1] === 'stdout' && route[2] === '*'))) ambiguous.push(line);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { exits, stdout, ambiguous };
}

export function validateRegistry(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.exits) || !Array.isArray(value.stdout)) throw new Error('Invalid process boundary registry');
  for (const category of ['exits', 'stdout']) {
    const seen = new Set();
    for (const entry of value[category]) {
      if (!/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(entry.path ?? '') || entry.path.includes('..') ||
          !Number.isSafeInteger(entry.maxCalls) || entry.maxCalls < 0 ||
          typeof entry.reason !== 'string' || entry.reason.trim().length < 10 ||
          !['cli', 'terminal', 'process_entry', 'fixture'].includes(entry.kind)) throw new Error('Invalid process boundary grant');
      const key = entry.path.toLowerCase();
      if (seen.has(key)) throw new Error('Duplicate process boundary grant');
      seen.add(key);
    }
  }
  return value;
}

export function inspectTree(root) {
  const sourceRoot = join(root, 'babel-cli/src');
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source tree contains a symbolic link');
      if (entry.isDirectory()) {
        if (!['test', 'tests', 'node_modules', 'dist'].includes(entry.name)) walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        results.push({ path: 'src/' + relative(sourceRoot, path).replaceAll('\\', '/'), ...inspectSource(readFileSync(path, 'utf8'), path) });
      }
    }
  }
  walk(sourceRoot);
  const policy = validateRegistry(JSON.parse(readFileSync(join(root, 'config/architectural-budget/process-boundaries.json'), 'utf8')));
  const failures = { exits: [], stdout: [] };
  for (const file of results) {
    if (file.ambiguous.length) failures.exits.push(`${file.path} has ambiguous dynamic process calls at ${file.ambiguous.join(',')}`);
    for (const category of ['exits', 'stdout']) {
      if (category === 'stdout' && !file.path.startsWith('src/ui/')) continue;
      const grant = policy[category].find(entry => entry.path === file.path);
      const allowed = grant?.maxCalls ?? 0;
      if (file[category].length > allowed) failures[category].push(`${file.path} has ${file[category].length} host ${category} call(s), budget ${allowed}`);
    }
  }
  return { failures, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(inspectTree(process.argv[2])) + '\n'); }
  catch (error) { process.stderr.write(`Architectural boundary scan failed: ${error.message}\n`); process.exitCode = 1; }
}
