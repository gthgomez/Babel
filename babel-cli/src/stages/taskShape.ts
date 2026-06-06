/**
 * taskShape.ts — Task shape classification and bounded contract logic
 *
 * Pure functions with no pipeline state dependencies. Extracted from pipeline.ts
 * to reduce its size and improve navigability.
 */

import { existsSync } from 'node:fs';
import { resolve }    from 'node:path';

import type { OrchestratorManifest } from '../schemas/agentContracts.js';
import {
  extractExactInvariants,
  formatExactInvariantPromptLines,
  type ExactInvariantRegistry,
} from './exactInvariants.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SemanticExpectation =
  | { kind: 'exported_symbol'; symbolName: string }
  | { kind: 'kotlin_object'; symbolName: string }
  | { kind: 'kotlin_function'; symbolName: string }
  | { kind: 'body_pattern'; name: string; description: string; pattern: RegExp; fileExtPattern: RegExp; expectedLiteral?: string };

export interface BoundedTaskContract {
  bounded: boolean;
  requestedTargets: string[];
  contentTargets: string[];
  reportTarget: string | null;
  exactInvariants: ExactInvariantRegistry;
  semanticExpectations: SemanticExpectation[];
  expectationsByTarget: Map<string, SemanticExpectation[]>;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const NON_FILE_DOTTED_TOKENS = new Set([
  'next.js',
  'node.js',
  'react.js',
  'vue.js',
  'express.js',
  'electron.js',
  'backbone.js',
  'ember.js',
  'nuxt.js',
  'svelte.js',
]);

const KNOWN_STANDALONE_FILE_EXTENSIONS = new Set([
  'cjs',
  'comp',
  'css',
  'java',
  'js',
  'json',
  'kt',
  'md',
  'mjs',
  'ps1',
  'sh',
  'ts',
  'tsx',
  'txt',
  'yaml',
  'yml',
]);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractBlankDefaultLiteral(taskText: string): string | null {
  const task = String(taskText ?? '');
  const match =
    /(?:returns?|defaults?\s+to|default(?:ing)?)\s+["']([^"'`\r\n]+)["'][^.,;\r\n]{0,80}\b(?:if|when|for)\b[^.,;\r\n]{0,80}\b(?:blank|empty)\b/i.exec(task)
    ?? /\b(?:blank|empty)\b[^.]*\b(?:returns?|defaults?\s+to|default(?:ing)?)\s+["']([^"'`\r\n]+)["']/i.exec(task);
  const literal = match?.[1]?.trim();
  return literal ? literal : null;
}

export function hasBlankDefaultLiteral(content: string, expectedLiteral: string): boolean {
  const escapedBlankDefaultLiteral = escapeRegExp(expectedLiteral);
  const pattern = new RegExp(
    `(?=[\\s\\S]*(?:\\bisBlank\\(\\)|\\bisEmpty\\(\\)|\\.trim\\(\\)\\s*\\.isEmpty\\(\\)|\\.length\\s*[=<]=\\s*0))(?=[\\s\\S]*["']${escapedBlankDefaultLiteral}["'])`,
  );
  return pattern.test(content);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}

export function normalizePathForComparison(value: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeIdentifier(value: string): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function mergeTaskContext(primaryTask: string, secondaryTask: string): string {
  const merged = uniqueStrings([
    String(primaryTask ?? '').trim(),
    String(secondaryTask ?? '').trim(),
  ]);
  return merged.join('\n\n');
}

export function isWriteReportTarget(target: string): boolean {
  return /(^|[\\/])write_report\.md$/i.test(String(target ?? ''));
}

export function getPathBasename(target: string): string {
  return String(target ?? '').replace(/\\/g, '/').split('/').at(-1) ?? '';
}

// ─── Semantic expectations ────────────────────────────────────────────────────

export function buildSemanticExpectationsFromTask(taskText: string): SemanticExpectation[] {
  const expectations: SemanticExpectation[] = [];
  const task = String(taskText ?? '');

  const exportedMatch = /exports?[^.\r\n]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(task);
  if (exportedMatch?.[1]) {
    expectations.push({ kind: 'exported_symbol', symbolName: exportedMatch[1] });
  }

  const kotlinObjectMatch = /\bkotlin\s+object\s+named\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(task)
    ?? /\bobject\s+named\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(task);
  if (kotlinObjectMatch?.[1]) {
    expectations.push({ kind: 'kotlin_object', symbolName: kotlinObjectMatch[1] });
  }

  const kotlinFunctionMatch = /\bexposing\s+fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(task)
    ?? /\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(task);
  if (kotlinFunctionMatch?.[1]) {
    expectations.push({ kind: 'kotlin_function', symbolName: kotlinFunctionMatch[1] });
  }

  if (/\b(?:replace|convert|replac(?:es?|ing)|transform)\b[^.]*\bspaces?\b[^.]*\bunderscores?\b/i.test(task)) {
    expectations.push({
      kind: 'body_pattern',
      name: 'space_to_underscore',
      description: 'replace spaces with underscores',
      pattern: /\.replace\(\s*["' ][ ]["' ]\s*,\s*["']_["']\s*\)|\.replace\(\s*(?:Regex\s*\(|"[^"]*\\s[^"]*"\.toRegex\s*\()/,
      fileExtPattern: /\.(?:kt|java)$/i,
    });
  }

  const blankDefaultLiteral = extractBlankDefaultLiteral(task);
  if (blankDefaultLiteral) {
    expectations.push({
      kind: 'body_pattern',
      name: 'blank_input_default',
      description: `return "${blankDefaultLiteral}" for blank or empty input`,
      pattern: /.*/s,
      fileExtPattern: /\.(?:kt|java)$/i,
      expectedLiteral: blankDefaultLiteral,
    });
  }

  if (/\bformatDisplayName\s*\(\s*firstName\s*:\s*string\s*,\s*lastName\s*:\s*string\s*,\s*email\s*:\s*string\s*\)/i.test(task)) {
    expectations.push({
      kind: 'body_pattern',
      name: 'format_display_name_contract',
      description: 'formatDisplayName must accept firstName, lastName, and email, trim names, and fall back to email',
      pattern: /formatDisplayName\s*\(\s*firstName\s*:\s*string\s*,\s*lastName\s*:\s*string\s*,\s*email\s*:\s*string\s*\)[\s\S]*(?:firstName[\s\S]*trim\(\)|trim\(\)[\s\S]*firstName)[\s\S]*(?:lastName[\s\S]*trim\(\)|trim\(\)[\s\S]*lastName)[\s\S]*email/,
      fileExtPattern: /\.(?:ts|tsx)$/i,
    });
  }

  if (/\brenderToggle\s*\(\s*label\s*,\s*enabled\s*\)/i.test(task)) {
    expectations.push({
      kind: 'body_pattern',
      name: 'render_toggle_contract',
      description: 'renderToggle must emit an accessible button with aria-pressed and enabled/disabled classes',
      pattern: /renderToggle[\s\S]*button[\s\S]*aria-pressed[\s\S]*toggle-widget--enabled[\s\S]*toggle-widget--disabled/,
      fileExtPattern: /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i,
    });
    expectations.push({
      kind: 'body_pattern',
      name: 'render_toggle_css_contract',
      description: 'toggle widget CSS must style the base, enabled, and disabled classes',
      pattern: /\.toggle-widget[\s\S]*\.toggle-widget--enabled[\s\S]*\.toggle-widget--disabled/,
      fileExtPattern: /\.css$/i,
    });
  }

  if (/\bBillMapper\.displayAmount\s*\(\s*amountCents\s*\)/i.test(task)) {
    expectations.push({
      kind: 'body_pattern',
      name: 'bill_entity_display_amount_contract',
      description: 'BillEntity must expose displayAmount() that delegates to BillMapper.displayAmount(amountCents)',
      pattern: /fun\s+displayAmount\s*\(\s*\)\s*:\s*String[\s\S]*BillMapper\.displayAmount\s*\(\s*amountCents\s*\)/,
      fileExtPattern: /BillEntity\.kt$/i,
    });
  }

  return expectations;
}

// ─── Bounded task contract ────────────────────────────────────────────────────

export function extractRequestedFileTargets(userRequest: string): string[] {
  const matches = String(userRequest ?? '').match(/(?:[A-Za-z]:[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,12}/g) ?? [];
  const filtered = matches.filter(match => {
    const normalized = match.trim().toLowerCase();
    if (NON_FILE_DOTTED_TOKENS.has(normalized)) {
      return false;
    }
    if (!/[\\/]/.test(normalized)) {
      const extension = normalized.split('.').at(-1) ?? '';
      if (!KNOWN_STANDALONE_FILE_EXTENSIONS.has(extension)) {
        return false;
      }
    }
    if (!/[\\/]/.test(normalized) && (normalized.match(/\./g)?.length ?? 0) > 1) {
      return false;
    }
    return true;
  });
  return uniqueStrings(filtered);
}

function extractNamedOutputTargets(userRequest: string): string[] {
  const task = String(userRequest ?? '');
  const targets: string[] = [];
  const patterns = [
    /\b(?:binary\s+)?executable\s+(?:called|named)\s+["'`]?([A-Za-z0-9_.-]+)["'`]?/gi,
    /\bfile\s+called\s+["'`]?([A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12})["'`]?/gi,
    /\bfile\s+named\s+["'`]?([A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12})["'`]?/gi,
  ];

  for (const pattern of patterns) {
    for (const match of task.matchAll(pattern)) {
      const target = match[1]?.trim();
      if (target && !target.includes('*') && target !== '.' && target !== '..') {
        targets.push(target);
      }
    }
  }

  const finalOutputMatch = /\b(?:your\s+)?final\s+outputs?\s+should\b[^\r\n]{0,500}/i.exec(task);
  if (finalOutputMatch?.[0]) {
    const finalOutputTargets = finalOutputMatch[0].match(/[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12}/g) ?? [];
    targets.push(...finalOutputTargets);
  }

  return uniqueStrings(targets.map(target => normalizePathForComparison(target)));
}

function lastRegexIndex(value: string, pattern: RegExp): number {
  let lastIndex = -1;
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of value.matchAll(globalPattern)) {
    if (typeof match.index === 'number') {
      lastIndex = match.index;
    }
  }
  return lastIndex;
}

function isWriteRequestedTarget(userRequest: string, target: string): boolean {
  const escapedTarget = target.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]');
  const targetPattern = new RegExp(escapedTarget, 'ig');
  const writeIntentPattern = /\b(create|write|add|generate|draft|modify|update|fix|repair|refactor|replace|delete|rename|edit|output|save)\b|\bnew\s+file\s+(?:named|called)?\b|\bfile\s+(?:named|called)\b/i;
  const readIntentPattern =
    /\b(read|view|inspect|open|look\s+at|scan|review)\b|\bcheck\s+(?:the\s+)?(?:file|path|directory|repo|repository)\b/i;
  const noModifyIntentPattern =
    /\b(?:do\s+not|don't|must\s+not|should\s+not|never)\s+(?:modify|edit|change|rewrite|touch|alter|update|write)\b|\b(?:without|no)\s+(?:modification|changes?|edits?)\b|\b(?:preserve|leave|keep)\b[^.;,\r\n]{0,80}\b(?:unchanged|unmodified|as-is|intact)\b/i;

  for (const match of userRequest.matchAll(targetPattern)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const beforeWindow = userRequest.slice(Math.max(0, index - 100), index);
    const afterWindow = userRequest.slice(index + match[0].length, Math.min(userRequest.length, index + match[0].length + 80));
    const before = beforeWindow.split(/\bthen\b|[,;]/i).at(-1) ?? beforeWindow;
    const after = afterWindow.split(/\b(?:and|then)\b|[,.;]/i)[0] ?? afterWindow;
    const context = `${before} ${after}`;
    if (/\b(?:gives?|produces?|equals?|matches?|same\s+as|identical\s+to|exactly)\s*$/i.test(beforeWindow)) {
      continue;
    }
    if (/\b(?:your\s+)?final\s+outputs?\s+should\b/i.test(beforeWindow)) {
      return true;
    }
    if (noModifyIntentPattern.test(context)) {
      continue;
    }
    const lastWrite = lastRegexIndex(context, writeIntentPattern);
    const lastRead = lastRegexIndex(context, readIntentPattern);
    if (lastWrite >= 0 && lastWrite >= lastRead) {
      return true;
    }
  }

  return false;
}

function isExternalBenchmarkRequest(rawTask: string): boolean {
  return /\bTerminal-Bench 2 task\b/i.test(rawTask) ||
    /\bSWE-rebench\b/i.test(rawTask);
}

export function normalizeRequestedFileTargetsForBoundedContract(userRequest: string): string[] {
  const namedOutputTargets = extractNamedOutputTargets(userRequest);
  const namedOutputTargetSet = new Set(namedOutputTargets.map(target => target.toLowerCase()));
  const requestedTargets = uniqueStrings([
    ...extractRequestedFileTargets(userRequest),
    ...namedOutputTargets,
  ])
    .map(target => normalizePathForComparison(target));

  const pathLikeBasenames = new Set(
    requestedTargets
      .filter(target => /[\\/]/.test(target))
      .map(target => getPathBasename(target).toLowerCase()),
  );

  const deDuplicatedTargets = requestedTargets.filter(target => {
    if (/[\\/]/.test(target)) {
      return true;
    }
    return !pathLikeBasenames.has(target.toLowerCase());
  });

  const writeTargets = deDuplicatedTargets.filter(target =>
    namedOutputTargetSet.has(target.toLowerCase()) || isWriteRequestedTarget(userRequest, target),
  );
  return writeTargets.length > 0 ? writeTargets : deDuplicatedTargets;
}

export function getRequestedTargetContract(rawTask: string): BoundedTaskContract {
  const requestedTargets = normalizeRequestedFileTargetsForBoundedContract(rawTask);
  const reportTarget = requestedTargets.find(target => isWriteReportTarget(target)) ?? null;
  const contentTargets = requestedTargets.filter(target => !isWriteReportTarget(target));
  const exactInvariants = extractExactInvariants(rawTask);
  const semanticExpectations = buildSemanticExpectationsFromTask(rawTask);
  const expectationsByTarget = new Map<string, SemanticExpectation[]>();

  const addExpectation = (target: string, expectation: SemanticExpectation): void => {
    const bucket = expectationsByTarget.get(target) ?? [];
    bucket.push(expectation);
    expectationsByTarget.set(target, bucket);
  };

  for (const expectation of semanticExpectations) {
    if (expectation.kind === 'body_pattern') {
      const target = contentTargets.find(t => expectation.fileExtPattern.test(t))
        ?? contentTargets[0];
      if (target) {
        addExpectation(target, expectation);
      }
      continue;
    }

    const preferredPattern =
      expectation.kind === 'exported_symbol'
        ? /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i
        : /\.(?:kt|java)$/i;
    const normalizedSymbol = normalizeIdentifier(expectation.symbolName);
    const directMatches = contentTargets.filter(target => {
      if (!preferredPattern.test(target)) {
        return false;
      }
      const basename = getPathBasename(target).replace(/\.[^.]+$/, '');
      const normalizedBasename = normalizeIdentifier(basename);
      return normalizedBasename === normalizedSymbol ||
        normalizedBasename.includes(normalizedSymbol) ||
        normalizedSymbol.includes(normalizedBasename);
    });

    if (directMatches.length > 0) {
      directMatches.forEach(target => addExpectation(target, expectation));
      continue;
    }

    const fallbackTarget = contentTargets.find(target => preferredPattern.test(target))
      ?? contentTargets[0];
    if (fallbackTarget) {
      addExpectation(fallbackTarget, expectation);
    }
  }

  return {
    bounded: requestedTargets.length > 0 && requestedTargets.length <= 4,
    requestedTargets,
    contentTargets,
    reportTarget,
    exactInvariants,
    semanticExpectations,
    expectationsByTarget,
  };
}

// ─── Prompt line builders ─────────────────────────────────────────────────────

export function getBoundedTaskPlanningLines(rawTask: string): string[] {
  const contract = getRequestedTargetContract(rawTask);
  const exactInvariantLines = formatExactInvariantPromptLines(contract.exactInvariants, 'planning');
  if (!contract.bounded) {
    return exactInvariantLines;
  }

  const externalBenchmark = isExternalBenchmarkRequest(rawTask);
  const lines = externalBenchmark
    ? [
        'Bounded benchmark output contract:',
        `  - Exact final artifact targets: ${contract.requestedTargets.join(', ')}`,
        '  - The final artifacts must exist at those exact paths before completion.',
        '  - Helper scripts/source files are allowed when they are necessary to compute, compile, compress, or generate the final artifacts.',
        '  - Do NOT rename final artifacts, relocate them, or substitute generic report filenames.',
      ]
    : [
        'Bounded output contract:',
        `  - Exact requested targets: ${contract.requestedTargets.join(', ')}`,
        '  - For this bounded task, every requested target must appear as an exact file_write target in the plan.',
        '  - Do NOT rename outputs, relocate them, add substitute helper files, or invent alternate report filenames.',
        '  - Keep file_write targets inside the explicit requested target set unless the user explicitly asked for additional files.',
      ];

  for (const target of contract.contentTargets) {
    if (/\.(?:css)$/i.test(target)) {
      lines.push(`  - ${target} must contain real stylesheet content with at least one selector block; do not leave it empty or placeholder-only.`);
    }
  }

  for (const [target, expectations] of contract.expectationsByTarget.entries()) {
    for (const expectation of expectations) {
      if (expectation.kind === 'exported_symbol') {
        lines.push(`  - ${target} must export the exact symbol "${expectation.symbolName}".`);
      } else if (expectation.kind === 'kotlin_object') {
        lines.push(`  - ${target} must declare \`object ${expectation.symbolName}\`; do NOT substitute a class with a companion object.`);
      } else if (expectation.kind === 'body_pattern') {
        lines.push(`  - ${target} must implement the following behavior: ${expectation.description}.`);
      } else {
        lines.push(`  - ${target} must expose \`fun ${expectation.symbolName}(...)\`.`);
      }
    }
  }

  if (exactInvariantLines.length > 0) {
    lines.push('', ...exactInvariantLines);
  }

  return lines;
}

export function getBoundedTaskQaLines(rawTask: string): string[] {
  const contract = getRequestedTargetContract(rawTask);
  const exactInvariantLines = formatExactInvariantPromptLines(contract.exactInvariants, 'qa');
  if (!contract.bounded) {
    return exactInvariantLines;
  }

  const externalBenchmark = isExternalBenchmarkRequest(rawTask);
  return [
    externalBenchmark ? '--- BOUNDED BENCHMARK CONTRACT REVIEW ---' : '--- BOUNDED CONTRACT REVIEW ---',
    'If the user named exact output files, the plan must preserve that contract literally.',
    `Exact requested targets: ${contract.requestedTargets.join(', ')}`,
    ...(externalBenchmark
      ? [
          'Do not reject helper file_write steps merely because they are outside the final artifact set.',
          'Reject only if the plan has no plausible step that creates each requested final artifact at its exact path.',
        ]
      : [
          'Reject the plan if any requested target is missing from the file_write steps.',
          'Reject the plan if any file_write step creates an unrequested file for this bounded task.',
        ]),
    'Reject the plan if the plan renames or relocates requested outputs or substitutes a generic report path.',
    ...(Array.from(contract.expectationsByTarget.entries()).flatMap(([target, expectations]) =>
      expectations.map(expectation => {
        if (expectation.kind === 'exported_symbol') {
          return `Reject the plan if ${target} is not treated as the file that must export "${expectation.symbolName}".`;
        }
        if (expectation.kind === 'kotlin_object') {
          return `Reject the plan if ${target} is not treated as the file that must declare \`object ${expectation.symbolName}\`.`;
        }
        if (expectation.kind === 'body_pattern') {
          return `Reject the plan if ${target} does not implement the following behavior: ${expectation.description}.`;
        }
        return `Reject the plan if ${target} is not treated as the file that must expose \`fun ${expectation.symbolName}(...)\`.`;
      })
    )),
    ...(exactInvariantLines.length > 0
      ? [
          '',
          ...exactInvariantLines,
        ]
      : []),
  ];
}

export function getBoundedExecutorContractLines(rawTask: string): string[] {
  const contract = getRequestedTargetContract(rawTask);
  const exactInvariantLines = formatExactInvariantPromptLines(contract.exactInvariants, 'executor');
  if (!contract.bounded) {
    return exactInvariantLines;
  }

  const externalBenchmark = isExternalBenchmarkRequest(rawTask);
  const lines = externalBenchmark
    ? [
        'Bounded benchmark execution contract:',
        `- Exact requested final artifacts: ${contract.requestedTargets.join(', ')}`,
        '- Helper scripts/source files are allowed if they are needed to produce the final artifacts.',
        '- Do NOT emit EXECUTION_COMPLETE until the requested final artifacts exist at those exact paths.',
      ]
    : [
        'Bounded execution contract:',
        `- Exact requested write targets: ${contract.requestedTargets.join(', ')}`,
        '- Do NOT write any file outside that exact target set unless the prompt explicitly names it.',
      ];

  for (const [target, expectations] of contract.expectationsByTarget.entries()) {
    for (const expectation of expectations) {
      if (expectation.kind === 'exported_symbol') {
        lines.push(`- ${target} must export the exact symbol "${expectation.symbolName}".`);
      } else if (expectation.kind === 'kotlin_object') {
        lines.push(`- ${target} must contain \`object ${expectation.symbolName}\`; do NOT emit a class/companion-object substitute.`);
      } else if (expectation.kind === 'body_pattern') {
        lines.push(`- ${target} must implement the following behavior: ${expectation.description}.`);
      } else {
        lines.push(`- ${target} must contain \`fun ${expectation.symbolName}(...)\`.`);
      }
    }
  }

  for (const target of contract.contentTargets) {
    if (/\.(?:css)$/i.test(target)) {
      lines.push(`- ${target} must include at least one concrete CSS selector block.`);
    }
  }

  if (exactInvariantLines.length > 0) {
    lines.push('', ...exactInvariantLines);
  }

  return lines;
}

// ─── Task classifiers ─────────────────────────────────────────────────────────

export function isAndroidWarningCleanupRequest(
  userRequest: string,
  projectRoot: string | undefined,
): { match: boolean; targets: string[]; reason: string } {
  const normalized = String(userRequest ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const targetPaths = normalizeRequestedFileTargetsForBoundedContract(userRequest)
    .filter(target => !isWriteReportTarget(target));
  const cleanupSignals = /\b(warning|warnings|deprecation|deprecated|unused|cleanup|clean up|lint|compiler warning)\b/.test(normalized);
  const creationSignals = /\b(fix|replace|update|clean up|cleanup|remove)\b/.test(normalized);
  const androidFileTargets = targetPaths.length > 0 && targetPaths.every(target => /\.(kt|java)$/i.test(target));

  if (!creationSignals || !cleanupSignals || !androidFileTargets) {
    return { match: false, targets: targetPaths, reason: 'request is not a bounded Android warning-cleanup task' };
  }

  if (targetPaths.length > 4) {
    return { match: false, targets: targetPaths, reason: 'request targets too many Android files for warning cleanup' };
  }

  if (projectRoot) {
    const existingTargets = targetPaths.filter(target => existsSync(resolve(projectRoot, target)));
    if (existingTargets.length !== targetPaths.length) {
      const missingTargets = targetPaths.filter(target => !existsSync(resolve(projectRoot, target)));
      return {
        match: false,
        targets: targetPaths,
        reason: `request references missing Android file(s): ${missingTargets.join(', ')}`,
      };
    }
  }

  return { match: true, targets: targetPaths, reason: 'bounded Android warning/deprecation cleanup task' };
}

function isSimpleNewFileCreationRequest(
  userRequest: string,
  projectRoot: string | undefined,
): { simple: boolean; targets: string[]; reason: string } {
  const normalized = String(userRequest ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const targetPaths = extractRequestedFileTargets(userRequest)
    .filter(target => !isWriteReportTarget(target));
  const createSignals = /\b(create|write|draft|add|generate)\b/.test(normalized);
  const nonCreationSignals = /\b(modify|update|fix|refactor|rename|delete|audit|review|analy[sz]e|debug|investigate|compare|verify|test|run|migrate|repair)\b/.test(normalized);
  const verificationHeavySignals = /\b(claim|competitive|teardown|pricing|evidence|reality|adversarial)\b/.test(normalized);

  if (!createSignals) {
    return { simple: false, targets: targetPaths, reason: 'request is not creation-oriented' };
  }
  if (nonCreationSignals) {
    return { simple: false, targets: targetPaths, reason: 'request mixes creation with modify/fix/review/test work' };
  }
  if (targetPaths.length === 0) {
    const summarizedNewFileSignals = /\b(new file|new module|new helper|new function|typescript function|kotlin object|utility function)\b/.test(normalized);
    if (!summarizedNewFileSignals) {
      return { simple: false, targets: targetPaths, reason: 'request does not target a small bounded file set' };
    }
    return { simple: true, targets: targetPaths, reason: 'bounded new-file creation summary without explicit file paths' };
  }
  if (targetPaths.length > 4) {
    return { simple: false, targets: targetPaths, reason: 'request does not target a small bounded file set' };
  }
  if (verificationHeavySignals) {
    return { simple: false, targets: targetPaths, reason: 'request includes audit or verification signals' };
  }

  if (projectRoot) {
    const existingTargets = targetPaths.filter(target => existsSync(resolve(projectRoot, target)));
    if (existingTargets.length > 0) {
      return {
        simple: false,
        targets: targetPaths,
        reason: `request references existing file(s): ${existingTargets.join(', ')}`,
      };
    }
  }

  return { simple: true, targets: targetPaths, reason: 'bounded greenfield file creation request' };
}

function isResearchSynthesisWriteRequest(
  userRequest: string,
): { match: boolean; targets: string[]; reason: string } {
  const normalized = String(userRequest ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const targetPaths = extractRequestedFileTargets(userRequest)
    .filter(target => !isWriteReportTarget(target));
  const synthesisSignals = /\b(summariz(?:e|ing)|summary|observe|observations|notes|synthesis|write up|write-up|memo|brief)\b/.test(normalized);
  const creationSignals = /\b(create|write|draft|generate)\b/.test(normalized);
  const auditSignals = /\b(audit|verify|verification|review|critique|adversarial|compare claims?|reality check|competitive)\b/.test(normalized);
  const markdownLikeTargets = targetPaths.length > 0 && targetPaths.every(target => /\.(md|txt)$/i.test(target));

  if (!creationSignals || !synthesisSignals) {
    return { match: false, targets: targetPaths, reason: 'request is not a synthesis/write task' };
  }
  if (auditSignals) {
    return { match: false, targets: targetPaths, reason: 'request includes audit or verification signals' };
  }
  if (!markdownLikeTargets) {
    return { match: false, targets: targetPaths, reason: 'request does not target note-style output files' };
  }

  return { match: true, targets: targetPaths, reason: 'research synthesis or note-writing task' };
}

export function isAndroidUtilityFileRequest(
  userRequest: string,
  projectRoot: string | undefined,
): { match: boolean; targets: string[]; reason: string } {
  const normalized = String(userRequest ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const targetPaths = extractRequestedFileTargets(userRequest)
    .filter(target => !isWriteReportTarget(target));
  const creationSignals = /\b(create|write|draft|generate|add)\b/.test(normalized);
  const androidFileTargets = targetPaths.length > 0 && targetPaths.every(target => /\.(kt|java)$/i.test(target));
  const summarizedUtilitySignals = /\b(new file|kotlin object|utility|helper)\b/.test(normalized);
  const governanceSignals = /\b(billing|play store|play-store|policy|manifest|permission|permissions|export|exports|compliance|iap|purchase|product id|pro_product_id)\b/.test(normalized);

  if (!creationSignals || (!androidFileTargets && !summarizedUtilitySignals)) {
    return { match: false, targets: targetPaths, reason: 'request is not a bounded Android source-file creation task' };
  }
  if (governanceSignals) {
    return { match: false, targets: targetPaths, reason: 'request touches Android governance or policy-sensitive surfaces' };
  }

  if (targetPaths.length === 0) {
    return { match: true, targets: targetPaths, reason: 'bounded Android utility-file creation summary without explicit file paths' };
  }

  if (projectRoot && hasGradleProjectMarkers(projectRoot)) {
    const existingTargets = targetPaths.filter(target => existsSync(resolve(projectRoot, target)));
    if (existingTargets.length > 0) {
      return {
        match: false,
        targets: targetPaths,
        reason: `request references existing Android file(s): ${existingTargets.join(', ')}`,
      };
    }
  }

  return { match: true, targets: targetPaths, reason: 'bounded Android utility-file creation task' };
}

function hasGradleProjectMarkers(projectRoot: string): boolean {
  return [
    'settings.gradle',
    'settings.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
    'gradlew',
    'gradlew.bat',
    'app/build.gradle',
    'app/build.gradle.kts',
  ].some(relativePath => existsSync(resolve(projectRoot, relativePath)));
}

function isAndroidUiImprovementRequest(
  userRequest: string,
  projectRoot: string | undefined,
): { match: boolean; targets: string[]; reason: string } {
  const normalized = String(userRequest ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const targetPaths = extractRequestedFileTargets(userRequest)
    .filter(target => !isWriteReportTarget(target));
  const improvementSignals = /\b(improve|improvement|better|polish|refine|enhance|upgrade|tweak)\b/.test(normalized);
  const uiSignals = /\b(ui|compose|screen|layout|accessibility|adaptive|date input|due date|payday|form|flow)\b/.test(normalized);
  const creationSignals = /\b(create|write|draft|generate|add|fix|update|modify|improve|enhance|refine|polish)\b/.test(normalized);
  const auditSignals = /\b(audit|verify|verification|review|critique|compare|inspect|evidence)\b/.test(normalized);
  const androidFileTargets = targetPaths.length > 0 && targetPaths.every(target => /\.(kt|java)$/i.test(target));

  if (!improvementSignals || !uiSignals || !creationSignals || auditSignals) {
    return { match: false, targets: targetPaths, reason: 'request is not a bounded Android UI-improvement task' };
  }

  if (targetPaths.length > 0 && !androidFileTargets) {
    return { match: false, targets: targetPaths, reason: 'request targets non-Android files' };
  }

  if (projectRoot && targetPaths.length > 0) {
    const existingTargets = targetPaths.filter(target => existsSync(resolve(projectRoot, target)));
    if (existingTargets.length > 0) {
      return {
        match: false,
        targets: targetPaths,
        reason: `request references existing Android file(s): ${existingTargets.join(', ')}`,
      };
    }
  }

  return {
    match: true,
    targets: targetPaths,
    reason: targetPaths.length > 0
      ? 'bounded Android UI-improvement task with explicit target files'
      : 'bounded Android UI-improvement task summary',
  };
}

function isComplianceArtifactWriteRequest(
  userRequest: string,
  projectRoot: string | undefined,
): { match: boolean; targets: string[]; reason: string } {
  const normalized = String(userRequest ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const targetPaths = extractRequestedFileTargets(userRequest)
    .filter(target => !isWriteReportTarget(target));
  const creationSignals = /\b(create|write|draft|generate|produce)\b/.test(normalized);
  const artifactSignals = /\b(checklist|template|guide|memo|brief|summary|readiness|sign-?off|control owners?|retention|evidence)\b/.test(normalized);
  const currentStateSignals = /\b(existing|current|repo|repository|implementation|actual|review|verify|verification|validate|inspect|compare|gap analysis|assess|scrutinize)\b/.test(normalized);
  const markdownLikeTargets = targetPaths.length > 0 && targetPaths.every(target => /\.(md|txt)$/i.test(target));

  if (!creationSignals || !artifactSignals || !markdownLikeTargets) {
    return { match: false, targets: targetPaths, reason: 'request is not a bounded compliance artifact-writing task' };
  }
  if (currentStateSignals) {
    return { match: false, targets: targetPaths, reason: 'request references current-state verification or repo inspection' };
  }

  if (projectRoot) {
    const existingTargets = targetPaths.filter(target => existsSync(resolve(projectRoot, target)));
    if (existingTargets.length > 0) {
      return {
        match: false,
        targets: targetPaths,
        reason: `request references existing compliance artifact file(s): ${existingTargets.join(', ')}`,
      };
    }
  }

  return { match: true, targets: targetPaths, reason: 'bounded compliance artifact-writing task' };
}

function trimExplicitSkillIdsForTaskShape(
  domainId: string,
  taskShapeProfile: string,
  skillIds: string[],
): { skillIds: string[]; removedSkillIds: string[] } {
  const removalMap = new Set<string>();

  if (taskShapeProfile === 'greenfield_file_creation' && domainId === 'domain_swe_frontend') {
    [
      'skill_react_nextjs',
      'skill_vite_react',
      'skill_a11y_design',
      'skill_evidence_gathering',
      'skill_bcdp_contracts',
      'skill_playwright_e2e',
    ].forEach(skillId => removalMap.add(skillId));
  }

  if (taskShapeProfile === 'android_utility_file' && domainId === 'domain_android_kotlin') {
    [
      'skill_android_app_classification',
      'skill_android_app_bundle',
      'skill_android_release_build',
      'skill_android_play_store_compliance',
      'skill_android_saf',
      'skill_jetpack_compose',
      'skill_evidence_gathering',
      'skill_bcdp_contracts',
    ].forEach(skillId => removalMap.add(skillId));
  }

  if (taskShapeProfile === 'android_ui_improvement' && domainId === 'domain_android_kotlin') {
    [
      'skill_android_app_bundle',
      'skill_android_play_store_compliance',
      'skill_evidence_gathering',
      'skill_bcdp_contracts',
    ].forEach(skillId => removalMap.add(skillId));
  }

  if (taskShapeProfile === 'android_warning_cleanup' && domainId === 'domain_android_kotlin') {
    [
      'skill_android_app_classification',
      'skill_android_app_bundle',
      'skill_android_play_store_compliance',
      'skill_android_saf',
      'skill_jetpack_compose',
      'skill_evidence_gathering',
      'skill_bcdp_contracts',
    ].forEach(skillId => removalMap.add(skillId));
  }

  if (removalMap.size === 0) {
    return { skillIds: [...skillIds], removedSkillIds: [] };
  }

  const nextSkillIds = skillIds.filter(skillId => !removalMap.has(skillId));
  const removedSkillIds = skillIds.filter(skillId => removalMap.has(skillId));
  return { skillIds: nextSkillIds, removedSkillIds };
}

// ─── Manifest task-shape application ─────────────────────────────────────────

export function maybeApplyManifestTaskShapeProfile(
  manifest: OrchestratorManifest,
  rawTask: string,
  projectRoot: string | undefined,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack || !manifest.resolution_policy) {
    return { manifest, warnings: [], applied: false };
  }

  if (!manifest.resolution_policy.apply_domain_default_skills) {
    return { manifest, warnings: [], applied: false };
  }

  const taskText = mergeTaskContext(rawTask, manifest.handoff_payload.user_request);
  let taskShapeProfile = manifest.resolution_policy.task_shape_profile ?? 'full';
  let triggerReason = '';
  let targets: string[] = [];
  const domainId = manifest.instruction_stack.domain_id;

  if (
    domainId === 'domain_swe_backend' ||
    domainId === 'domain_swe_frontend'
  ) {
    const decision = isSimpleNewFileCreationRequest(taskText, projectRoot);
    if (decision.simple) {
      taskShapeProfile = 'greenfield_file_creation';
      triggerReason = decision.reason;
      targets = decision.targets;
    }
  } else if (domainId === 'domain_research') {
    const synthesisDecision = isResearchSynthesisWriteRequest(taskText);
    if (synthesisDecision.match) {
      taskShapeProfile = 'synthesis_write';
      triggerReason = synthesisDecision.reason;
      targets = synthesisDecision.targets;
    } else {
      const creationDecision = isSimpleNewFileCreationRequest(taskText, projectRoot);
      if (creationDecision.simple) {
        taskShapeProfile = 'greenfield_file_creation';
        triggerReason = creationDecision.reason;
        targets = creationDecision.targets;
      }
    }
  } else if (domainId === 'domain_android_kotlin') {
    const uiImprovementDecision = isAndroidUiImprovementRequest(taskText, projectRoot);
    if (uiImprovementDecision.match) {
      taskShapeProfile = 'android_ui_improvement';
      triggerReason = uiImprovementDecision.reason;
      targets = uiImprovementDecision.targets;
    } else {
      const warningCleanupDecision = isAndroidWarningCleanupRequest(taskText, projectRoot);
      if (warningCleanupDecision.match) {
        taskShapeProfile = 'android_warning_cleanup';
        triggerReason = warningCleanupDecision.reason;
        targets = warningCleanupDecision.targets;
      } else {
        const androidDecision = isAndroidUtilityFileRequest(taskText, projectRoot);
        if (androidDecision.match) {
          taskShapeProfile = 'android_utility_file';
          triggerReason = androidDecision.reason;
          targets = androidDecision.targets;
        }
      }
    }
  } else if (domainId === 'domain_compliance_gpc') {
    const complianceDecision = isComplianceArtifactWriteRequest(taskText, projectRoot);
    if (complianceDecision.match) {
      taskShapeProfile = 'compliance_artifact_write';
      triggerReason = complianceDecision.reason;
      targets = complianceDecision.targets;
    }
  }

  if (taskShapeProfile === 'full') {
    return { manifest, warnings: [], applied: false };
  }

  const { skillIds: trimmedSkillIds, removedSkillIds } = trimExplicitSkillIdsForTaskShape(
    domainId,
    taskShapeProfile,
    manifest.instruction_stack.skill_ids,
  );

  const trimmedManifest: OrchestratorManifest = {
    ...manifest,
    instruction_stack: {
      ...manifest.instruction_stack,
      skill_ids: trimmedSkillIds,
    },
    resolution_policy: {
      ...manifest.resolution_policy,
      task_shape_profile: taskShapeProfile,
    },
  };
  const warnings = [
    `[STACK_OPTIMIZATION] Applied task-shape profile "${taskShapeProfile}" in ${manifest.instruction_stack.domain_id}. Explicit skills retained: ${trimmedSkillIds.join(', ') || 'none'}.`,
    ...(removedSkillIds.length > 0
      ? [`[STACK_OPTIMIZATION] Removed broad explicit skills for bounded task shape: ${removedSkillIds.join(', ')}.`]
      : []),
    `[STACK_OPTIMIZATION] Trigger reason: ${triggerReason}. Targets: ${targets.join(', ') || 'none'}.`,
  ];
  return { manifest: trimmedManifest, warnings, applied: true };
}
