import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../babel-cli/package.json', import.meta.url));
const ts = require('typescript');

/** Inspect executable host calls. Strings containing child programs are data,
 * not host exits; their lifecycle is covered by process-containment tests. */
export function inspectSource(source, path = 'source.ts') {
  path = ts.normalizePath(path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) throw new Error(`Cannot parse source for boundary inspection: ${path}`);
  function hasNativeSeed(node) {
    if (ts.isIdentifier(node) && ['require', 'Reflect', 'global', 'globalThis'].includes(node.text) ||
        ts.isStringLiteralLike(node) && ['module', 'node:module', 'process', 'node:process'].includes(node.text) || node.kind === ts.SyntaxKind.ImportKeyword) return true;
    // A local Function adapter can borrow a host target. Include process aliases,
    // boundary members and computed projections; direct non-boundary properties
    // cannot supply an exit/writer origin and need no native graph traversal.
    if (ts.isIdentifier(node) && node.text === 'process' && (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || ['exit', 'stdout'].includes(node.parent.name.text))) return true;
    return Boolean(ts.forEachChild(node, hasNativeSeed));
  }
  // Every supported native origin derives from one of these AST seeds. Avoid
  // repeatedly exploring unrelated recursive data aliases when none exists.
  const hasNativeOrigins = hasNativeSeed(sf);
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
  const carrierSymbols = new WeakMap();
  const instanceSymbols = new WeakMap();
  const classFields = new Map();
  const resolvingClassExpressions = new Set();
  const nativeInvocations = new WeakMap();
  const resolvingNativeInvocations = new WeakSet();
  let nativeOriginsReady = false, mutationDepth = 0;
  const globalProcessSymbol = Symbol('unshadowed global process');
  const globalObjectSymbol = Symbol('unshadowed global object');
  const globalReflectSymbol = Symbol('unshadowed global Reflect');
  const implicitGlobals = new Map([['process', globalProcessSymbol], ['global', globalObjectSymbol], ['globalThis', globalObjectSymbol], ['Reflect', globalReflectSymbol]]);
  let hasBindOverrides = false;
  linkSymbols(globalProcessSymbol, globalObjectSymbol);
  linkSymbols(globalReflectSymbol, globalObjectSymbol);
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
  function carrierSymbol(node) {
    const named = node.name && checker.getSymbolAtLocation(node.name);
    if (named) return named;
    if (!carrierSymbols.has(node)) carrierSymbols.set(node, Symbol('anonymous class owner'));
    return carrierSymbols.get(node);
  }
  const hasStatic = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
  function instanceSymbol(node) {
    if (!instanceSymbols.has(node)) instanceSymbols.set(node, Symbol('local class instance owner'));
    return instanceSymbols.get(node);
  }
  function localClasses(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || resolvingClassExpressions.has(expression)) return null;
    resolvingClassExpressions.add(expression);
    try { return resolveLocalClasses(expression, seen); }
    finally { resolvingClassExpressions.delete(expression); }
  }
  function resolveLocalClasses(expression, seen) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return null;
    seen = new Set(seen).add(expression);
    if (ts.isClassDeclaration(expression) || ts.isClassExpression(expression)) return [expression];
    if (ts.isAwaitExpression(expression)) return localClasses(expression.expression, seen);
    if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.CommaToken, ts.SyntaxKind.EqualsToken].includes(expression.operatorToken.kind)) return localClasses(expression.right, seen);
    if (ts.isConditionalExpression(expression)) {
      const left = localClasses(expression.whenTrue, seen), right = localClasses(expression.whenFalse, seen);
      return left && right ? [...left, ...right] : null;
    }
    let symbol;
    if (ts.isIdentifier(expression)) symbol = identifierSymbol(expression);
    else if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || ts.isQualifiedName(expression)) {
      const receiver = ts.isQualifiedName(expression) ? expression.left : expression.expression;
      if (aliasRoots(receiver).some(hasHostMutation)) return null;
      symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : ts.isQualifiedName(expression) ? expression.right : expression);
      if (!symbol) return classProjection(receiver, [ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isQualifiedName(expression) ? expression.right.text : ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression) ? expression.argumentExpression.text : '*'], seen);
    } else return null;
    const values = [];
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) values.push(declaration);
      else if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) { if (declaration.initializer) values.push(declaration.initializer); }
      else if (ts.isShorthandPropertyAssignment(declaration)) values.push(declaration.name);
      else if (ts.isImportEqualsDeclaration(declaration) && !ts.isExternalModuleReference(declaration.moduleReference)) values.push(declaration.moduleReference);
      else if (ts.isBindingElement(declaration)) {
        let element = declaration, keys = [];
        while (ts.isBindingElement(element)) {
          if (element.initializer) {
            const defaults = classProjection(element.initializer, keys, seen);
            if (defaults === null) return null;
            values.push(...defaults);
          }
          keys.unshift(ts.isArrayBindingPattern(element.parent) ? String(element.parent.elements.indexOf(element)) : propertyKey(element.propertyName ?? element.name));
          element = element.parent.parent;
        }
        const projected = classProjection(declarationSource(element), keys, seen);
        if (projected === null) return null;
        values.push(...projected);
      }
      else return null;
    }
    for (const assigned of assignments.get(symbol) ?? []) {
      if (assigned.keys.length) return null;
      values.push(assigned.expression);
    }
    const resolved = values.map(value => localClasses(value, seen));
    return resolved.length && resolved.every(Boolean) ? resolved.flat() : null;
  }
  function classProjection(expression, keys, seen) {
    expression = unwrap(expression);
    if (!expression) return [];
    if (!keys.length) return localClasses(expression, seen);
    if (seen.has(expression)) return null;
    seen = new Set(seen).add(expression);
    const [key, ...rest] = keys;
    let candidates;
    if (ts.isObjectLiteralExpression(expression)) {
      candidates = expression.properties.filter(property => !ts.isSpreadAssignment(property) && (key === '*' || propertyKey(property.name) === key)).map(property => ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined);
      if (expression.properties.some(ts.isSpreadAssignment)) return null;
    } else if (ts.isArrayLiteralExpression(expression)) {
      const elements = literalArrayElements(expression);
      if (!elements) return null;
      candidates = key === '*' ? elements : [elements[Number(key)]].filter(Boolean);
    } else if (ts.isModuleDeclaration(expression)) {
      candidates = namespaceDeclarations(expression).filter(declaration => key === '*' || propertyKey(declaration.name) === key).map(namespaceValue);
    } else if (ts.isQualifiedName(expression)) {
      return classProjection(expression.left, [expression.right.text, ...keys], seen);
    } else if (ts.isPropertyAccessExpression(expression)) {
      return classProjection(expression.expression, [expression.name.text, ...keys], seen);
    } else if (ts.isElementAccessExpression(expression)) {
      return classProjection(expression.expression, [ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression) ? expression.argumentExpression.text : '*', ...keys], seen);
    } else if (ts.isIdentifier(expression)) {
      const symbol = identifierSymbol(expression);
      const sources = (symbol?.declarations ?? []).flatMap(declaration => ts.isVariableDeclaration(declaration) ? [declaration.initializer].filter(Boolean) : ts.isModuleDeclaration(declaration) ? [declaration] : ts.isImportEqualsDeclaration(declaration) && !ts.isExternalModuleReference(declaration.moduleReference) ? [declaration.moduleReference] : []);
      sources.push(...(assignments.get(symbol) ?? []).filter(value => !value.keys.length).map(value => value.expression));
      const routes = sources.map(source => classProjection(source, keys, seen));
      return routes.length && routes.every(route => route !== null) ? routes.flat() : null;
    } else return null;
    const routes = candidates.map(candidate => classProjection(candidate, rest, seen));
    return routes.every(route => route !== null) ? routes.flat() : null;
  }
  const baseExpressions = node => (node.heritageClauses ?? []).filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword).flatMap(clause => clause.types.map(type => type.expression));
  function instanceFields(node) {
    return node.members.flatMap(member => ts.isConstructorDeclaration(member)
      ? member.parameters.filter(parameter => ts.isParameterPropertyDeclaration(parameter, member))
      : ts.isPropertyDeclaration(member) && !hasStatic(member) ? [member] : []);
  }
  function instanceValues(node, seen = new Set()) {
    if (seen.has(node)) return [];
    seen = new Set(seen).add(node);
    return [...instanceFields(node).map(member => member.initializer).filter(Boolean),
      ...baseExpressions(node).flatMap(base => (localClasses(base) ?? []).flatMap(owner => instanceValues(owner, seen)))];
  }
  function hasHostBase(node, seen = new Set()) {
    if (seen.has(node)) return true;
    seen = new Set(seen).add(node);
    return baseExpressions(node).some(base => {
      const owners = localClasses(base);
      return owners ? owners.some(owner => hasHostBase(owner, seen)) : Boolean(access(base));
    });
  }
  function carrierValues(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return [
      ...node.members.filter(member => ts.isPropertyDeclaration(member) && hasStatic(member)).map(member => member.initializer).filter(Boolean),
      ...baseExpressions(node),
    ];
    return namespaceDeclarations(node).map(namespaceValue).filter(Boolean);
  }
  function namespaceDeclarations(node) {
    if (!ts.isModuleDeclaration(node) || !node.body) return [];
    if (ts.isModuleDeclaration(node.body)) return [node.body];
    return node.body.statements.filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).flatMap(statement =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : ts.isModuleDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && !ts.isExternalModuleReference(statement.moduleReference) ? [statement] : []);
  }
  function namespaceValue(declaration) {
    return ts.isVariableDeclaration(declaration) ? declaration.initializer : ts.isImportEqualsDeclaration(declaration) ? declaration.moduleReference : declaration;
  }
  function thisOwner(node) {
    for (let owner = node.parent; owner; owner = owner.parent) {
      if (ts.isClassStaticBlockDeclaration(owner)) return { node: owner.parent, static: true };
      if (ts.isConstructorDeclaration(owner)) return { node: owner.parent, static: false };
      if (ts.isPropertyDeclaration(owner) || ts.isMethodDeclaration(owner) || ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) return ts.isClassDeclaration(owner.parent) || ts.isClassExpression(owner.parent) ? { node: owner.parent, static: hasStatic(owner) } : null;
      if (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) return null;
    }
    return null;
  }
  function instanceOwners(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return null;
    seen = new Set(seen).add(expression);
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = thisOwner(expression);
      return owner && !owner.static ? [owner.node] : null;
    }
    if (ts.isNewExpression(expression)) return localClasses(expression.expression);
    if (ts.isAwaitExpression(expression)) return instanceOwners(expression.expression, seen);
    if (!ts.isIdentifier(expression)) return null;
    const symbol = identifierSymbol(expression);
    const values = (symbol?.declarations ?? []).filter(ts.isVariableDeclaration).map(declaration => declaration.initializer).filter(Boolean);
    values.push(...(assignments.get(symbol) ?? []).filter(value => !value.keys.length).map(value => value.expression));
    const owners = values.map(value => instanceOwners(value, seen));
    return owners.length && owners.every(Boolean) ? owners.flat() : null;
  }
  function classMemberAccess(owner, isStatic, key, seen, bases = new Set()) {
    if (bases.has(owner)) return ['process', '*'];
    bases = new Set(bases).add(owner);
    const symbol = isStatic ? carrierSymbol(owner) : instanceSymbol(owner);
    if (hasHostMutation(symbol)) return ['process', '*'];
    const fields = (isStatic ? owner.members.filter(field => ts.isPropertyDeclaration(field) && hasStatic(field)) : instanceFields(owner)).filter(field => key === '*' || propertyKey(field.name) === key);
    const stored = classFields.get(symbol);
    const values = [...fields.map(field => field.initializer), ...(key === '*' ? [...(stored?.values() ?? [])].flat() : stored?.get(key) ?? [])];
    const routes = values.map(value => access(value, seen));
    for (const base of baseExpressions(owner)) for (const parent of localClasses(base) ?? []) routes.push(classMemberAccess(parent, isStatic, key, seen, bases));
    return key === '*' ? routes.some(Boolean) ? ['process', '*'] : null : mergeAccess(routes);
  }
  function aliasRoots(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return [];
    seen = new Set(seen).add(expression);
    const roots = value => aliasRoots(value, seen);
    if (ts.isIdentifier(expression)) return [identifierSymbol(expression)].filter(Boolean);
    if (ts.isClassDeclaration(expression) || ts.isClassExpression(expression) || ts.isModuleDeclaration(expression)) return [carrierSymbol(expression), ...carrierValues(expression).flatMap(roots)];
    if (ts.isNewExpression(expression)) return (localClasses(expression.expression) ?? []).flatMap(owner => [instanceSymbol(owner), ...instanceValues(owner).flatMap(roots)]);
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = thisOwner(expression);
      return owner ? [owner.static ? carrierSymbol(owner.node) : instanceSymbol(owner.node)] : [];
    }
    if (isProcessImport(expression)) return [globalProcessSymbol];
    if (ts.isAwaitExpression(expression)) return roots(expression.expression);
    if (ts.isQualifiedName(expression)) return roots(expression.left);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return roots(expression.expression);
    if (ts.isConditionalExpression(expression)) return [...roots(expression.whenTrue), ...roots(expression.whenFalse)];
    if (ts.isBinaryExpression(expression)) {
      if ([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken].includes(expression.operatorToken.kind)) return roots(expression.right);
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(expression.operatorToken.kind)) return [...roots(expression.left), ...roots(expression.right)];
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap(element => roots(ts.isSpreadElement(element) ? element.expression : element));
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.flatMap(property => roots(ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : ts.isSpreadAssignment(property) ? property.expression : null));
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
  function hasHostMutation(symbol) {
    const component = mutationsFor(symbol);
    if (component.recognized === undefined && !component.evaluating) {
      component.evaluating = true;
      mutationDepth++;
      try { component.recognized = component.mutations.some(({ expression, target }) => {
        const route = access(expression);
        if (!route) return (localClasses(expression) ?? []).some(owner => instanceValues(owner).some(value => access(value)));
        // Restoring the same known host method does not introduce a new route.
        return !['process.exit', 'process.stdout.write'].includes(route.join('.')) || access(target)?.join('.') !== route.join('.');
      }); }
      finally { component.evaluating = false; mutationDepth--; }
    }
    return component.recognized;
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
      const receiver = unwrap(target.expression);
      const owner = receiver.kind === ts.SyntaxKind.ThisKeyword && thisOwner(receiver);
      if (owner && key !== '*') {
        const symbol = owner.static ? carrierSymbol(owner.node) : instanceSymbol(owner.node);
        if (!classFields.has(symbol)) classFields.set(symbol, new Map());
        const fields = classFields.get(symbol);
        fields.set(key, [...(fields.get(key) ?? []), expression]);
        linkAliases(symbol, expression);
        return;
      }
      for (const symbol of aliasRoots(target.expression)) {
        containerMutations.set(symbol, [...(containerMutations.get(symbol) ?? []), { expression, target }]);
        linkAliases(symbol, expression);
      }
    }
  }
  function collectAssignments(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isModuleDeclaration(node)) for (const value of carrierValues(node)) linkAliases(carrierSymbol(node), value);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const value of instanceValues(node)) linkAliases(instanceSymbol(node), value);
      for (const base of baseExpressions(node)) for (const owner of localClasses(base) ?? []) linkSymbols(instanceSymbol(node), instanceSymbol(owner));
    }
    if ((ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) && ['process', 'node:process'].includes(moduleOf(node))) linkSymbols(node.name && checker.getSymbolAtLocation(node.name), globalProcessSymbol);
    if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) collectTarget(node.name, node.moduleReference);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) && ['bind', '*'].includes(propertyKey(node.name))) hasBindOverrides = true;
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) linkAliases(checker.getSymbolAtLocation(node.name), declarationSource(node));
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
  mutationComponents.clear();
  nativeOriginsReady = true;
  function member(base, key) {
    if (!base) return null;
    if (!base.length && key === 'Reflect') return ['reflect'];
    if (base.join('.') === 'reflect' && !['apply', '*'].includes(key)) return null;
    if (base.join('.') === 'process') {
      if (key === 'default') return base;
      // Process data and unrelated methods cannot become exit/stdout boundaries.
      if (!['exit', 'stdout', '*'].includes(key)) return null;
    }
    if (base.join('.') === 'process.stdout' && !['write', '*'].includes(key)) return null;
    return [...base, key];
  }
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
  function nativeOrigin(kind) { return kind ? { kind, operations: [] } : null; }
  function mergeNativeOrigins(routes) {
    const recognized = routes.filter(Boolean);
    const identity = origin => origin.kind + (origin.route?.join('.') ?? '') + JSON.stringify(origin.operations.map(operation => typeof operation === 'string' ? operation : operation.map(argument => argument.pos)));
    return new Set(recognized.map(identity)).size > 1 ? nativeOrigin('ambiguous') : recognized[0] ?? null;
  }
  function projectNativeOrigin(origin, keys) {
    for (const key of keys) {
      if (!origin) return null;
      if (origin.kind === 'ambiguous') continue;
      if (origin.kind === 'module' && ['default', 'Module'].includes(key)) continue;
      if (origin.kind === 'module' && key === 'createRequire') origin = nativeOrigin('factory');
      else if (origin.kind === 'global' && key === 'Reflect') origin = nativeOrigin('reflect');
      else if (origin.kind === 'reflect' && key === 'apply') origin = nativeOrigin('reflection');
      else if (['factory', 'loader', 'reflection', 'host', 'ordinary'].includes(origin.kind) && ['bind', 'call', 'apply'].includes(key)) origin = { ...origin, operations: [...origin.operations, key] };
      else origin = key === '*' ? nativeOrigin('ambiguous') : null;
    }
    return origin;
  }
  function callableNativeOrigin(expression, seen) {
    const origin = nativeLoaderOrigin(expression, [], seen);
    if (origin && ['factory', 'loader', 'reflection', 'host', 'ambiguous'].includes(origin.kind)) return origin;
    const route = access(expression);
    return route?.[0] === 'process' ? { ...nativeOrigin('host'), route } : origin?.kind === 'ordinary' ? origin : null;
  }
  function invokeNativeOrigin(origin, arguments_, seen, receiver) {
    if (!origin || !['factory', 'loader', 'reflection', 'host', 'ordinary', 'ambiguous'].includes(origin.kind)) return null;
    if (origin.kind === 'ambiguous') return origin;
    let args = [...arguments_];
    const operations = [...origin.operations];
    function redirectReceiver(expression) {
      if (typeof operations.at(-1) !== 'string') return true;
      const adapter = operations.at(-1);
      const actual = callableNativeOrigin(expression, seen);
      if (!actual) return false;
      origin = actual;
      operations.splice(0, operations.length, ...actual.operations, adapter);
      return true;
    }
    if (receiver && !redirectReceiver(receiver)) return null;
    // Reverse adapter application preserves both pre-bound arguments and later
    // call/apply wrappers; only known intrinsic operations are interpreted.
    while (operations.length) {
      const operation = operations.pop();
      if (Array.isArray(operation)) args = [...operation, ...args];
      else if (operation === 'bind') {
        if (!redirectReceiver(args[0])) return null;
        return { ...origin, operations: [...operations, args.slice(1)] };
      }
      else if (operation === 'call') {
        if (!redirectReceiver(args[0])) return null;
        args = args.slice(1);
      }
      else {
        if (!redirectReceiver(args[0])) return null;
        const array = unwrap(args[1]);
        if (!array || !ts.isArrayLiteralExpression(array)) return nativeOrigin(origin.kind === 'factory' ? 'loader' : 'ambiguous');
        args = literalArrayElements(array);
        if (!args) return nativeOrigin('ambiguous');
      }
    }
    if (origin.kind === 'host') return { ...origin, kind: 'hostInvocation', operations: [] };
    // Known local callbacks are identities only: their bodies are inspected by
    // the normal AST walk, and their arguments/return values are not evaluated.
    if (origin.kind === 'ordinary') return nativeOrigin('ordinaryInvocation');
    if (origin.kind === 'factory') return nativeOrigin('loader');
    if (origin.kind === 'reflection') {
      const target = nativeLoaderOrigin(args[0], [], seen);
      const array = unwrap(args[2]);
      if (!target) return null;
      return array && ts.isArrayLiteralExpression(array) ? invokeNativeOrigin(target, literalArrayElements(array) ?? [], seen, args[1]) : nativeOrigin(target.kind === 'factory' ? 'loader' : 'ambiguous');
    }
    const name = unwrap(args[0]);
    if (!name || !ts.isStringLiteralLike(name)) return null;
    return nativeOrigin(['process', 'node:process'].includes(name.text) ? 'process' : ['module', 'node:module'].includes(name.text) ? 'module' : null);
  }
  function nativeClassProjection(owner, isStatic, keys, seen, bases = new Set()) {
    if (!keys.length || bases.has(owner)) return null;
    bases = new Set(bases).add(owner);
    const [key, ...rest] = keys;
    const fields = (isStatic ? owner.members.filter(field => ts.isPropertyDeclaration(field) && hasStatic(field)) : instanceFields(owner)).filter(field => key === '*' || propertyKey(field.name) === key);
    const stored = classFields.get(isStatic ? carrierSymbol(owner) : instanceSymbol(owner));
    const values = [...fields.map(field => field.initializer), ...(key === '*' ? [...(stored?.values() ?? [])].flat() : stored?.get(key) ?? [])];
    return mergeNativeOrigins([...values.map(value => nativeLoaderOrigin(value, rest, seen)), ...baseExpressions(owner).flatMap(base => (localClasses(base) ?? []).map(parent => nativeClassProjection(parent, isStatic, keys, seen, bases)))]);
  }
  function nativeLoaderOrigin(expression, keys = [], seen = new Set()) {
    expression = unwrap(expression);
    if (!expression || seen.has(expression)) return null;
    seen = new Set(seen).add(expression);
    const resolve = (value, path = keys) => nativeLoaderOrigin(value, path, seen);
    const combine = mergeNativeOrigins;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isFunctionDeclaration(expression)) return projectNativeOrigin(nativeOrigin('ordinary'), keys);
    if (ts.isAwaitExpression(expression)) return resolve(expression.expression);
    if (ts.isBinaryExpression(expression)) {
      if ([ts.SyntaxKind.CommaToken, ts.SyntaxKind.EqualsToken].includes(expression.operatorToken.kind)) return resolve(expression.right);
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(expression.operatorToken.kind)) return combine([resolve(expression.left), resolve(expression.right)]);
    }
    if (ts.isConditionalExpression(expression)) return combine([resolve(expression.whenTrue), resolve(expression.whenFalse)]);
    if (ts.isQualifiedName(expression)) return resolve(expression.left, [expression.right.text, ...keys]);
    if (ts.isPropertyAccessExpression(expression)) return resolve(expression.expression, [expression.name.text, ...keys]);
    if (ts.isElementAccessExpression(expression)) return resolve(expression.expression, [ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression) ? expression.argumentExpression.text : '*', ...keys]);
    if (ts.isCallExpression(expression)) {
      const callee = expression.expression.kind === ts.SyntaxKind.ImportKeyword ? nativeOrigin('loader') : nativeLoaderOrigin(expression.expression, [], seen);
      return projectNativeOrigin(invokeNativeOrigin(callee, expression.arguments, seen), keys);
    }
    if (ts.isClassDeclaration(expression) || ts.isClassExpression(expression)) return nativeClassProjection(expression, true, keys, seen);
    if (ts.isNewExpression(expression)) return combine((localClasses(expression.expression) ?? []).map(owner => nativeClassProjection(owner, false, keys, seen)));
    if (expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = thisOwner(expression);
      return owner ? nativeClassProjection(owner.node, owner.static, keys, seen) : null;
    }
    if (ts.isModuleDeclaration(expression) && keys.length && expression.body) {
      return combine(namespaceDeclarations(expression).filter(declaration => declaration.name && (keys[0] === '*' || propertyKey(declaration.name) === keys[0])).map(declaration => resolve(namespaceValue(declaration), keys.slice(1))));
    }
    if (keys.length && ts.isObjectLiteralExpression(expression)) return combine(expression.properties.flatMap(property =>
      ts.isSpreadAssignment(property) ? [resolve(property.expression)] : (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && (keys[0] === '*' || propertyKey(property.name) === '*' || propertyKey(property.name) === keys[0]) ? [resolve(ts.isPropertyAssignment(property) ? property.initializer : property.name, keys.slice(1))] : []));
    if (keys.length && ts.isArrayLiteralExpression(expression)) {
      const elements = literalArrayElements(expression) ?? [];
      return keys[0] === '*' ? combine(elements.map(element => resolve(element, keys.slice(1)))) : resolve(elements[Number(keys[0])], keys.slice(1));
    }
    if (!ts.isIdentifier(expression)) return null;
    const symbol = identifierSymbol(expression);
    const declarations = (symbol?.declarations ?? []).filter(declaration => !isAmbientDeclaration(declaration));
    const routes = expression.text === 'require' && !declarations.length ? [projectNativeOrigin(nativeOrigin('loader'), keys)] : [];
    if (!declarations.length && implicitGlobals.get(expression.text) === globalReflectSymbol) routes.push(projectNativeOrigin(nativeOrigin('reflect'), keys));
    if (!declarations.length && implicitGlobals.get(expression.text) === globalObjectSymbol) routes.push(projectNativeOrigin(nativeOrigin('global'), keys));
    for (const declaration of declarations) {
      if (['node:module', 'module'].includes(moduleOf(declaration))) {
        if (ts.isImportSpecifier(declaration)) routes.push(projectNativeOrigin(nativeOrigin((declaration.propertyName?.text ?? declaration.name.text) === 'createRequire' ? 'factory' : ['default', 'Module'].includes(declaration.propertyName?.text ?? declaration.name.text) ? 'module' : null), keys));
        else if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration) || ts.isImportEqualsDeclaration(declaration)) routes.push(projectNativeOrigin(nativeOrigin('module'), keys));
      }
      if (ts.isImportEqualsDeclaration(declaration) && !ts.isExternalModuleReference(declaration.moduleReference)) routes.push(resolve(declaration.moduleReference));
      if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) routes.push(nativeTransferredOrigin(declarationSource(declaration), keys, seen));
      if (ts.isClassDeclaration(declaration) || ts.isModuleDeclaration(declaration)) routes.push(resolve(declaration));
      if (ts.isFunctionDeclaration(declaration)) routes.push(resolve(declaration));
      if (ts.isBindingElement(declaration)) {
        let element = declaration, path = keys, excluded = false;
        while (ts.isBindingElement(element)) {
          if (element.initializer) routes.push(resolve(element.initializer, path));
          if (element.dotDotDotToken) {
            if (ts.isObjectBindingPattern(element.parent)) excluded ||= element.parent.elements.some(sibling => sibling !== element && !sibling.dotDotDotToken && propertyKey(sibling.propertyName ?? sibling.name) === path[0]);
            else if (/^\d+$/.test(path[0] ?? '')) path = [String(Number(path[0]) + element.parent.elements.indexOf(element)), ...path.slice(1)];
          } else path = [ts.isArrayBindingPattern(element.parent) ? String(element.parent.elements.indexOf(element)) : propertyKey(element.propertyName ?? element.name), ...path];
          element = element.parent.parent;
        }
        if (!excluded) routes.push(nativeTransferredOrigin(declarationSource(element), path, seen));
      }
    }
    routes.push(...(assignments.get(symbol) ?? []).map(value => nativeTransferredOrigin(value.expression, [...value.keys, ...keys], seen)));
    if (keys.length) for (const mutation of mutationsFor(symbol).mutations) {
      const targetKeys = [];
      let target = unwrap(mutation.target);
      while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        targetKeys.unshift(ts.isPropertyAccessExpression(target) ? target.name.text : ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : '*');
        target = unwrap(target.expression);
      }
      if (targetKeys.length <= keys.length && targetKeys.every((key, index) => key === '*' || keys[index] === '*' || key === keys[index])) routes.push(resolve(mutation.expression, keys.slice(targetKeys.length)));
    }
    return combine(routes);
  }
  function nativeTransferredOrigin(expression, keys, seen) {
    const owner = expression?.parent;
    const iterated = owner && ts.isForOfStatement(owner) && owner.expression === expression;
    return nativeLoaderOrigin(expression, iterated ? ['*', ...keys] : keys, seen);
  }
  function isProcessImport(node) {
    return ts.isCallExpression(node) && ['process', 'ambiguous'].includes(nativeInvocationOrigin(node)?.kind);
  }
  function nativeInvocationOrigin(node) {
    if (!hasNativeOrigins) return null;
    if (nativeOriginsReady && mutationDepth === 0 && nativeInvocations.has(node)) return nativeInvocations.get(node);
    if (resolvingNativeInvocations.has(node)) return nativeOrigin('ambiguous');
    resolvingNativeInvocations.add(node);
    try {
      const origin = nativeLoaderOrigin(node);
      // Reuse only complete root queries after alias collection; mutation
      // evaluation and path-dependent recursive queries remain uncached.
      if (nativeOriginsReady && mutationDepth === 0) nativeInvocations.set(node, origin);
      return origin;
    } finally { resolvingNativeInvocations.delete(node); }
  }
  function boundReflectionAccess(callee, args, seen) {
    const adapter = callee.slice(0, -1).join('.');
    if (args.length <= 1) return callee.slice(0, -1);
    if (!['reflect.apply', 'reflect.apply.call', 'reflect.apply.apply'].includes(adapter)) return args.some(argument => access(argument, seen)?.[0] === 'process') ? ['process', '*'] : ['reflect', 'bound'];
    const index = adapter === 'reflect.apply' ? 1 : 2;
    if (args.length <= index) return ['reflect', 'bound'];
    const target = adapter === 'reflect.apply.apply' ? projectionAccess(args[index], ['0'], seen) : access(args[index], seen);
    if (target?.[0] === 'process') return target;
    if (target?.[0] === 'reflect') return args.slice(index + 1).some(argument => access(argument, seen)?.[0] === 'process') ? ['process', '*'] : ['reflect', 'bound'];
    return null;
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
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isModuleDeclaration(node)) return hasHostMutation(carrierSymbol(node)) || carrierValues(node).some(value => access(value, seen)) ? ['process', '*'] : null;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = thisOwner(node);
      if (!owner) return null;
      return owner.static ? access(owner.node, seen) : hasHostMutation(instanceSymbol(owner.node)) || instanceValues(owner.node).some(value => access(value, seen)) ? ['process', '*'] : null;
    }
    if (ts.isNewExpression(node)) return (localClasses(node.expression) ?? []).some(owner => hasHostMutation(instanceSymbol(owner)) || instanceValues(owner).some(value => access(value, seen))) ? ['process', '*'] : null;
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
      const receiver = unwrap(node.expression);
      const owner = receiver.kind === ts.SyntaxKind.ThisKeyword && thisOwner(receiver);
      if (owner) return classMemberAccess(owner.node, Boolean(owner.static), node.name.text, seen);
      const instances = instanceOwners(receiver);
      if (instances) return mergeAccess(instances.map(instance => classMemberAccess(instance, false, node.name.text, seen)));
      const base = access(node.expression, seen);
      return member(base, node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const receiver = unwrap(node.expression);
      const key = ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '*';
      const owner = receiver.kind === ts.SyntaxKind.ThisKeyword && thisOwner(receiver);
      if (owner) return classMemberAccess(owner.node, Boolean(owner.static), key, seen);
      const instances = instanceOwners(receiver);
      if (instances) return mergeAccess(instances.map(instance => classMemberAccess(instance, false, key, seen)));
      const base = access(node.expression, seen);
      return member(base, key);
    }
    if (ts.isCallExpression(node)) {
      if (isProcessImport(node)) return nativeInvocationOrigin(node)?.kind === 'process' ? ['process'] : ['process', '*'];
      const callee = access(node.expression, seen);
      if (unresolvedInvocation(callee)) return ['process', '*'];
      if (callee?.[0] === 'reflect' && callee.at(-1) === 'bind') return boundReflectionAccess(callee, node.arguments, seen);
      if (callee?.at(-1) === 'bind') return callee.slice(0, -1);
    }
    if (!ts.isIdentifier(node)) return null;
    const symbol = identifierSymbol(node);
    const declarations = symbol?.declarations ?? [];
    // All initializer and assignment routes for this symbol are explored below.
    // A back edge to that same symbol cannot add a new seed to the current path.
    if (symbol && seen.has(symbol)) return implicitGlobals.has(node.text) && declarations.length === 0
      ? node.text === 'process' ? ['process'] : node.text === 'Reflect' ? ['reflect'] : [] : null;
    if (symbol) seen = new Set(seen).add(symbol);
    // Every alias in a component shares its mutation seeds. Evaluate those seeds
    // once, independently of the caller's path; reentry follows declarations and
    // assignments without recursively expanding the same component again.
    if (hasHostMutation(symbol)) return ['process', '*'];
    if (implicitGlobals.has(node.text) && declarations.length === 0) {
      const initial = node.text === 'process' ? ['process'] : node.text === 'Reflect' ? ['reflect'] : [];
      return mergeAccess([initial, ...(assignments.get(symbol) ?? []).map(assigned => assignedAccess(assigned, seen))]);
    }
    const routes = [];
    for (const declaration of declarations) {
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration) || ts.isModuleDeclaration(declaration)) {
        routes.push(access(declaration, seen));
      }
      if (['node:process', 'process'].includes(moduleOf(declaration))) {
        if (ts.isImportSpecifier(declaration)) {
          const name = declaration.propertyName?.text ?? declaration.name.text;
          routes.push(name === 'default' ? ['process'] : member(['process'], name));
        }
        if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration)) routes.push(['process']);
      }
      if (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) {
        routes.push(access(declarationSource(declaration), seen));
      }
      if (ts.isBindingElement(declaration) && (ts.isObjectBindingPattern(declaration.parent) || ts.isArrayBindingPattern(declaration.parent))) {
        routes.push(bindingAccess(declaration, seen), access(declaration.initializer, seen));
      }
    }
    return mergeAccess([...routes, ...(assignments.get(symbol) ?? []).map(assigned => assignedAccess(assigned, seen))]);
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
      if (ts.isCallExpression(node)) {
        const native = nativeInvocationOrigin(node);
        if (native?.kind === 'hostInvocation') route = native.route;
        // A resolved local receiver supersedes the generic Reflect fallback.
        // Keep existing conservative host-mutation routes when present.
        if (native?.kind === 'ordinaryInvocation' && route?.[0] !== 'process') route = null;
      }
      if (ts.isNewExpression(node)) {
        const owners = localClasses(node.expression);
        if (owners && !owners.some(owner => hasHostBase(owner))) route = null;
      }
      // Intrinsic bind creates a function; invocation of that result is counted
      // separately. Explicit or dynamic local overrides retain ambiguity.
      if (route?.at(-1) === 'bind' && !hasBindOverrides) route = null;
      // Reflect.apply invokes its target argument, including transparent aliases
      // and the intrinsic's call/apply adapters. Unknown adapters fail closed
      // when their arguments carry a host boundary.
      if (route?.[0] === 'reflect') {
        const adapter = route.join('.');
        if (ts.isCallExpression(node) && adapter === 'reflect.apply') route = access(node.arguments[0]);
        else if (ts.isCallExpression(node) && adapter === 'reflect.apply.call') route = access(node.arguments[1]);
        else if (ts.isCallExpression(node) && adapter === 'reflect.apply.apply') route = projectionAccess(node.arguments[1], ['0'], new Set());
        else route = null;
        if (route?.[0] === 'reflect' || !['reflect.apply', 'reflect.apply.call', 'reflect.apply.apply'].includes(adapter)) route = ts.isCallExpression(node) && node.arguments.some(argument => access(argument)?.[0] === 'process') ? ['process', '*'] : null;
      }
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
