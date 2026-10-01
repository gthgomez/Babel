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
  const mutationComponents = new Map();
  const globalProcessSymbol = Symbol('unshadowed global process');
  const globalObjectSymbol = Symbol('unshadowed global object');
  const implicitGlobals = new Map([['process', globalProcessSymbol], ['global', globalObjectSymbol], ['globalThis', globalObjectSymbol]]);
  let hasBindOverrides = false;
  linkSymbols(globalProcessSymbol, globalObjectSymbol);
  function isAmbientDeclaration(node) {
    for (let owner = node; owner && !ts.isSourceFile(owner); owner = owner.parent) {
      if (owner.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
    }
    return false;
  }
  function identifierSymbol(node) {
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    const runtimeShadow = symbol?.declarations?.some(declaration => !isAmbientDeclaration(declaration));
    return !runtimeShadow && implicitGlobals.has(node.text) ? implicitGlobals.get(node.text) : symbol;
  }
  function unwrap(node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  }
  function propertyKey(name) {
    if (ts.isComputedPropertyName(name)) {
      const expression = unwrap(name.expression);
      return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) ? expression.text : '*';
    }
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : '*';
  }
  function aliasRoots(expression) {
    expression = unwrap(expression);
    if (!expression) return [];
    if (ts.isIdentifier(expression)) return [identifierSymbol(expression)].filter(Boolean);
    if (ts.isCallExpression(expression) && ((ts.isIdentifier(expression.expression) && expression.expression.text === 'require') || expression.expression.kind === ts.SyntaxKind.ImportKeyword) && ts.isStringLiteralLike(expression.arguments[0]) && ['process', 'node:process'].includes(expression.arguments[0].text)) return [globalProcessSymbol];
    if (ts.isAwaitExpression(expression)) return aliasRoots(expression.expression);
    if (ts.isQualifiedName(expression)) return aliasRoots(expression.left);
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
  function linkSymbols(symbol, other) {
    if (!symbol || !other) return;
    containerAliases.set(symbol, new Set([...(containerAliases.get(symbol) ?? []), other]));
    containerAliases.set(other, new Set([...(containerAliases.get(other) ?? []), symbol]));
  }
  function linkAliases(symbol, expression) {
    for (const other of aliasRoots(expression)) linkSymbols(symbol, other);
  }
  function mutationsFor(symbol) {
    if (mutationComponents.has(symbol)) return mutationComponents.get(symbol);
    const visited = new Set(), pending = [symbol], mutations = [];
    while (pending.length) {
      const current = pending.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      mutations.push(...(containerMutations.get(current) ?? []));
      pending.push(...(containerAliases.get(current) ?? []));
    }
    const component = { mutations, evaluating: false, recognized: undefined };
    for (const member of visited) mutationComponents.set(member, component);
    return component;
  }
  function collectTarget(target, expression, keys = [], bindingSymbol) {
    target = unwrap(target);
    if (!target) return;
    if (ts.isIdentifier(target)) {
      const symbol = bindingSymbol ?? identifierSymbol(target);
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
          collectTarget(property.initializer, expression, [...keys, propertyKey(key)]);
        } else if (ts.isSpreadAssignment(property)) collectTarget(property.expression, expression, keys);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      target.elements.forEach((element, index) => collectTarget(ts.isSpreadElement(element) ? element.expression : element, expression, [...keys, ts.isSpreadElement(element) ? '*' : String(index)]));
    } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectTarget(target.left, expression, keys);
      collectTarget(target.left, target.right);
    } else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const key = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : '*';
      if (key === 'bind' || key === '*') hasBindOverrides = true;
      for (const symbol of aliasRoots(target.expression)) {
        containerMutations.set(symbol, [...(containerMutations.get(symbol) ?? []), expression]);
        linkAliases(symbol, expression);
      }
    }
  }
  function collectAssignments(node) {
    if ((ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) && ['process', 'node:process'].includes(moduleOf(node))) linkSymbols(node.name && checker.getSymbolAtLocation(node.name), globalProcessSymbol);
    if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) collectTarget(node.name, node.moduleReference);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) && ['bind', '*'].includes(propertyKey(node.name))) hasBindOverrides = true;
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
    if (keys[0] === '*') return access(expression, seen) ? ['process', '*'] : null;
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
          if (!ts.isComputedPropertyName(name) && propertyKey(name) === keys[0]) routes.push(projectionAccess(value, keys.slice(1), seen));
          else if (ts.isComputedPropertyName(name)) {
            if (propertyKey(name) === keys[0]) routes.push(projectionAccess(value, keys.slice(1), seen));
            else if (propertyKey(name) === '*' && access(value, seen)) routes.push(['process', '*']);
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
    while (node && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)) node = node.parent;
    const expression = node && ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : node?.moduleSpecifier;
    return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
  }
  function mergeAccess(candidates) {
    const recognized = candidates.filter(Boolean);
    if (new Set(recognized.map(route => route.join('.'))).size > 1) return ['process', '*'];
    return recognized[0] ?? null;
  }
  function unresolvedInvocation(route) {
    if (route?.[0] !== 'process') return false;
    if (route.includes('*')) return true;
    let suffixes = 0;
    for (let index = route.length - 1; index > 0 && ['bind', 'call', 'apply'].includes(route[index]); index--) suffixes++;
    return suffixes > 1;
  }
  function access(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set(seen).add(node);
    if (ts.isQualifiedName(node)) return member(access(node.left, seen), node.right.text);
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
      if (unresolvedInvocation(callee)) return ['process', '*'];
      if (callee?.at(-1) === 'bind') return callee.slice(0, -1);
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = identifierSymbol(node);
    const declarations = symbol?.declarations ?? [];
    const component = mutationsFor(symbol);
    // Every alias in a component shares its mutation seeds. Evaluate those seeds
    // once, independently of the caller's path; reentry follows declarations and
    // assignments without recursively expanding the same component again.
    if (component.recognized === undefined && !component.evaluating) {
      component.evaluating = true;
      try { component.recognized = component.mutations.some(value => access(value)); }
      finally { component.evaluating = false; }
    }
    if (component.recognized) return ['process', '*'];
    if (node.text === 'process' && declarations.length === 0) return ['process'];
    if (['globalThis', 'global'].includes(node.text) && declarations.length === 0) return [];
    for (const declaration of declarations) {
      if (['node:process', 'process'].includes(moduleOf(declaration))) {
        if (ts.isImportSpecifier(declaration)) {
          const name = declaration.propertyName?.text ?? declaration.name.text;
          return name === 'default' ? ['process'] : member(['process'], name);
        }
        if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration)) return ['process'];
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
    return mergeAccess((assignments.get(symbol) ?? []).map(assigned => assignedAccess(assigned, seen)));
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
    const name = propertyKey(key);
    const projected = ts.isBindingElement(owner) ? member(base, name) : projectionAccess(declarationSource(owner), [name], seen);
    return mergeAccess([projected, access(element.initializer, seen)]);
  }
  const exits = [], stdout = [], ambiguous = [];
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      let route = access(ts.isTaggedTemplateExpression(node) ? node.tag : node.expression);
      // Intrinsic bind creates a function; invocation of that result is counted
      // separately. Explicit or dynamic local overrides retain ambiguity.
      if (route?.at(-1) === 'bind' && !hasBindOverrides) route = null;
      if (unresolvedInvocation(route)) route = ['process', '*'];
      if (['call', 'apply'].includes(route?.at(-1))) route = route.slice(0, -1);
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (route?.join('.') === 'process.exit') exits.push(line);
      if (route?.join('.') === 'process.stdout.write') stdout.push(line);
      if (unresolvedInvocation(route)) ambiguous.push(line);
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
