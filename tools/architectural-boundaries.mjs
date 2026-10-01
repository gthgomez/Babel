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
  const assignments = new Map();
  const containerMutations = new Map();
  const containerAliases = new Map();
  function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  }
  function aliasRoots(expression) {
    expression = unwrap(expression);
    if (!expression) return [];
    if (ts.isIdentifier(expression)) return [ts.isShorthandPropertyAssignment(expression.parent) && expression.parent.name === expression ? checker.getShorthandAssignmentValueSymbol(expression.parent) : checker.getSymbolAtLocation(expression)].filter(Boolean);
    if (ts.isAwaitExpression(expression)) return aliasRoots(expression.expression);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return aliasRoots(expression.expression);
    if (ts.isConditionalExpression(expression)) return [...aliasRoots(expression.whenTrue), ...aliasRoots(expression.whenFalse)];
    if (ts.isBinaryExpression(expression)) {
      if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken].includes(expression.operatorToken.kind)) return aliasRoots(expression.right);
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(expression.operatorToken.kind)) return [...aliasRoots(expression.left), ...aliasRoots(expression.right)];
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap(element => aliasRoots(ts.isSpreadElement(element) ? element.expression : element));
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.flatMap(property => aliasRoots(ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : ts.isSpreadAssignment(property) ? property.expression : null));
    return [];
  }
  function linkAliases(symbol, expression) {
    if (!symbol) return;
    for (const other of aliasRoots(expression)) {
      containerAliases.set(symbol, new Set([...(containerAliases.get(symbol) ?? []), other]));
      containerAliases.set(other, new Set([...(containerAliases.get(other) ?? []), symbol]));
    }
  }
  function mutationsFor(symbol) {
    const visited = new Set(), pending = [symbol], mutations = [];
    while (pending.length) {
      const current = pending.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      mutations.push(...(containerMutations.get(current) ?? []));
      pending.push(...(containerAliases.get(current) ?? []));
    }
    return mutations;
  }
  function collectTarget(target, expression, keys = [], bindingSymbol) {
    target = unwrap(target);
    if (!target) return;
    if (ts.isIdentifier(target)) {
      const symbol = bindingSymbol ?? checker.getSymbolAtLocation(target);
      if (!symbol) return;
      const values = assignments.get(symbol) ?? [];
      values.push({ expression, keys });
      assignments.set(symbol, values);
      linkAliases(symbol, expression);
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          collectTarget(property.name, expression, [...keys, property.name.text], symbol);
          if (property.objectAssignmentInitializer) collectTarget(property.name, property.objectAssignmentInitializer, [], symbol);
        }
        else if (ts.isPropertyAssignment(property)) {
          const key = property.name;
          collectTarget(property.initializer, expression, [...keys, ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '*']);
        } else if (ts.isSpreadAssignment(property)) collectTarget(property.expression, expression, keys);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      target.elements.forEach((element, index) => collectTarget(ts.isSpreadElement(element) ? element.expression : element, expression, [...keys, ts.isSpreadElement(element) ? '*' : String(index)]));
    } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectTarget(target.left, expression, keys);
      collectTarget(target.left, target.right);
    } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      for (const symbol of aliasRoots(target.expression)) {
        containerMutations.set(symbol, [...(containerMutations.get(symbol) ?? []), expression]);
        linkAliases(symbol, expression);
      }
    }
  }
  function collectAssignments(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) linkAliases(checker.getSymbolAtLocation(node.name), declarationSource(node));
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      let owner = node.parent.parent;
      while (ts.isBindingElement(owner)) {
        linkAliases(checker.getSymbolAtLocation(node.name), owner.initializer);
        owner = owner.parent.parent;
      }
      linkAliases(checker.getSymbolAtLocation(node.name), declarationSource(owner));
      linkAliases(checker.getSymbolAtLocation(node.name), node.initializer);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) collectTarget(node.left, node.right);
    if (ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer)) collectTarget(node.initializer, node.expression);
    ts.forEachChild(node, collectAssignments);
  }
  function declarationSource(declaration) {
    const owner = declaration.parent?.parent;
    return owner && ts.isForOfStatement(owner) && owner.initializer === declaration.parent ? owner.expression : declaration.initializer;
  }
  collectAssignments(sf);
  const member = (base, key) => {
    if (!base) return null;
    if (base.join('.') === 'process') {
      if (key === 'default') return base;
      // Process data and unrelated methods cannot become exit/stdout boundaries.
      if (!['exit', 'stdout', '*'].includes(key)) return null;
    }
    return [...base, key];
  };
  function assignedAccess(value, seen) {
    return projectionAccess(value.expression, value.keys, seen);
  }
  function projectionAccess(expression, keys, seen) {
    if (!keys.length) return access(expression, seen);
    while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression))) expression = expression.expression;
    if (expression && ts.isArrayLiteralExpression(expression) && /^\d+$/.test(keys[0])) {
      const elements = literalArrayElements(expression);
      return elements ? projectionAccess(elements[Number(keys[0])], keys.slice(1), seen) : access(expression, seen);
    }
    if (expression && ts.isObjectLiteralExpression(expression)) {
      const routes = [];
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) routes.push(projectionAccess(property.expression, keys, seen));
        else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
          const name = property.name;
          if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === keys[0]) routes.push(projectionAccess(value, keys.slice(1), seen));
          else if (ts.isComputedPropertyName(name)) {
            if (ts.isStringLiteralLike(name.expression) && name.expression.text === keys[0]) routes.push(projectionAccess(value, keys.slice(1), seen));
            else if (!ts.isStringLiteralLike(name.expression) && access(value, seen)) routes.push(['process', '*']);
          }
        }
      }
      return mergeAccess(routes);
    }
    return keys.reduce(member, access(expression, seen));
  }
  function literalArrayElements(expression) {
    const elements = [];
    for (const element of expression.elements) {
      if (!ts.isSpreadElement(element)) elements.push(element);
      else {
        let spread = element.expression;
        while (ts.isParenthesizedExpression(spread)) spread = spread.expression;
        if (!ts.isArrayLiteralExpression(spread)) return null;
        const nested = literalArrayElements(spread);
        if (!nested) return null;
        elements.push(...nested);
      }
    }
    return elements;
  }
  function moduleOf(node) {
    while (node && !ts.isImportDeclaration(node)) node = node.parent;
    return node?.moduleSpecifier?.text;
  }
  function mergeAccess(candidates) {
    const recognized = candidates.filter(Boolean);
    if (new Set(recognized.map(route => route.join('.'))).size > 1) return ['process', '*'];
    return recognized[0] ?? null;
  }
  function access(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isAwaitExpression(node)) return access(node.expression, seen);
    if (ts.isConditionalExpression(node)) return mergeAccess([access(node.whenTrue, seen), access(node.whenFalse, seen)]);
    if (ts.isBinaryExpression(node)) {
      if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken].includes(node.operatorToken.kind)) return access(node.right, seen);
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) return mergeAccess([access(node.left, seen), access(node.right, seen)]);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(element => access(ts.isSpreadElement(element) ? element.expression : element, seen)) ? ['process', '*'] : null;
    if (ts.isObjectLiteralExpression(node)) return node.properties.some(property => access(ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : ts.isSpreadAssignment(property) ? property.expression : null, seen)) ? ['process', '*'] : null;
    if (ts.isPropertyAccessExpression(node)) {
      const base = access(node.expression, seen);
      return member(base, node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const base = access(node.expression, seen);
      return member(base, ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '*');
    }
    if (ts.isCallExpression(node)) {
      if (((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
          ts.isStringLiteralLike(node.arguments[0]) && ['node:process', 'process'].includes(node.arguments[0].text)) return ['process'];
      const callee = access(node.expression, seen);
      if (callee?.at(-1) === 'bind') return callee.slice(0, -1);
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    const declarations = symbol?.declarations ?? [];
    if (mutationsFor(symbol).some(value => access(value, seen))) return ['process', '*'];
    if (node.text === 'process' && declarations.length === 0) return ['process'];
    if (['globalThis', 'global'].includes(node.text) && declarations.length === 0) return [];
    for (const declaration of declarations) {
      if (['node:process', 'process'].includes(moduleOf(declaration))) {
        if (ts.isImportSpecifier(declaration)) {
          const name = declaration.propertyName?.text ?? declaration.name.text;
          return name === 'default' ? ['process'] : member(['process'], name);
        }
        if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) return ['process'];
      }
      if (ts.isVariableDeclaration(declaration)) {
        const candidates = [access(declarationSource(declaration), seen), ...(assignments.get(symbol) ?? []).map(value => assignedAccess(value, seen))].filter(Boolean);
        if (new Set(candidates.map(route => route.join('.'))).size > 1) return ['process', '*'];
        if (candidates.length) return candidates[0];
      }
      if (ts.isBindingElement(declaration) && (ts.isObjectBindingPattern(declaration.parent) || ts.isArrayBindingPattern(declaration.parent))) {
        const candidates = [bindingAccess(declaration, seen), access(declaration.initializer, seen), ...(assignments.get(symbol) ?? []).map(value => assignedAccess(value, seen))].filter(Boolean);
        if (new Set(candidates.map(route => route.join('.'))).size > 1) return ['process', '*'];
        if (candidates.length) return candidates[0];
      }
    }
    for (const assigned of assignments.get(symbol) ?? []) {
      const route = assignedAccess(assigned, seen);
      if (route) return route;
    }
    return null;
  }
  function bindingAccess(element, seen) {
    const owner = element.parent.parent;
    if (ts.isArrayBindingPattern(element.parent)) {
      const index = element.parent.elements.indexOf(element);
      const key = element.dotDotDotToken ? '*' : String(index);
      const projected = ts.isBindingElement(owner) ? member(bindingAccess(owner, seen), key) : projectionAccess(declarationSource(owner), [key], seen);
      return mergeAccess([projected, access(element.initializer, seen)]);
    }
    const base = ts.isBindingElement(owner) ? bindingAccess(owner, seen) : access(declarationSource(owner), seen);
    if (element.dotDotDotToken) return mergeAccess([base, access(element.initializer, seen)]);
    const key = element.propertyName ?? element.name;
    const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '*';
    const projected = ts.isBindingElement(owner) ? member(base, name) : projectionAccess(declarationSource(owner), [name], seen);
    return mergeAccess([projected, access(element.initializer, seen)]);
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
