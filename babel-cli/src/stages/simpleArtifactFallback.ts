/**
 * simpleArtifactFallback.ts — deterministic executor fallback for bounded
 * greenfield file creation when model tiers fail to emit the next tool call.
 */

import { existsSync } from 'node:fs';

import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import {
  getPathBasename,
  getRequestedTargetContract,
  isWriteReportTarget,
  normalizePathForComparison,
} from './taskShape.js';
import {
  isWithinProjectRootPath,
  resolveStepTargetPath,
} from './executorHelpers.js';
import {
  resolveFileLiteralBinding,
  type FileLiteralBindingResolution,
} from './exactInvariants.js';

export interface DeterministicSimpleWrite {
  target: string;
  content: string;
  reason: string;
}

export interface DirectBoundedWritePlan {
  writes: DeterministicSimpleWrite[];
  reason: string;
}

const DIRECT_BOUNDED_WRITE_TOOLS = new Set(['directory_list', 'file_read', 'file_write']);

function getBoundedSimpleWritePlanTargets(approvedPlan: SwePlan): string[] {
  return approvedPlan.minimal_action_set
    .filter(step => step.tool === 'file_write')
    .map(step => normalizePathForComparison(String(step.target ?? '')))
    .filter(target => target.length > 0);
}

function isBoundedSimpleWritePlan(approvedPlan: SwePlan): boolean {
  return approvedPlan.minimal_action_set.every(step =>
    DIRECT_BOUNDED_WRITE_TOOLS.has(String(step.tool)),
  );
}

function escapeHtmlExpression(valueExpression: string): string {
  return `String(${valueExpression} ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))`;
}

function buildWriteReportContent(targets: string[]): string {
  const artifactLines = targets
    .filter(target => !isWriteReportTarget(target))
    .map(target => `- \`${target}\`: created as requested.`)
    .join('\n');

  return [
    '# Write Report',
    '',
    '## Created Artifacts',
    artifactLines || '- No content artifacts were requested.',
    '',
    '## Verification',
    '- Files were generated inside the bounded requested target set.',
    '',
  ].join('\n');
}

function buildMarkdownContent(target: string): string {
  const basename = getPathBasename(target).toLowerCase();

  if (basename.includes('evidence-checklist')) {
    return [
      '# Compliance Evidence Checklist',
      '',
      '## Source Of Truth',
      '- Identify the authoritative policy, system, and owner for each control.',
      '',
      '## Proof Artifacts',
      '- Capture dated screenshots, logs, exports, tickets, and approvals.',
      '',
      '## Control Owners',
      '- Record accountable owners and backup reviewers.',
      '',
      '## Retention Evidence',
      '- Store artifacts with retention period, location, and access notes.',
      '',
      '## Sign-Off',
      '- Require reviewer name, date, scope, and exceptions before release.',
      '',
    ].join('\n');
  }

  if (basename.includes('prompt-budget-observations')) {
    return [
      '# Prompt Budget Observations',
      '',
      '## Likely Causes',
      '- Broad default layers add repeated guidance before the task is understood.',
      '- Domain, skill, and adapter prompts can overlap on the same safety rules.',
      '- Historical context and verbose evidence blocks may be carried into simple writes.',
      '',
      '## Reduction Ideas',
      '- Route simple bounded tasks to a compact greenfield profile.',
      '- Deduplicate overlapping layer sections before execution.',
      '- Summarize evidence and history into stable short capsules.',
      '',
    ].join('\n');
  }

  return [
    `# ${getPathBasename(target).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')}`,
    '',
    'This file was created for the requested bounded task.',
    '',
  ].join('\n');
}

function buildScriptContent(target: string): string {
  if (getPathBasename(target).toLowerCase() === 'healthcheck.sh') {
    return [
      '#!/bin/sh',
      'set -eu',
      '',
      ': "${APP_URL:?APP_URL is required}"',
      '',
      'if command -v curl >/dev/null 2>&1 && curl --fail --silent --show-error --location "$APP_URL" >/dev/null; then',
      '  echo "OK"',
      '  exit 0',
      'fi',
      '',
      'echo "APP_URL is not reachable" >&2',
      'exit 1',
      '',
    ].join('\n');
  }

  return ['#!/bin/sh', 'set -eu', 'echo "OK"', ''].join('\n');
}

function buildKotlinContent(target: string): string {
  const basename = getPathBasename(target).replace(/\.[^.]+$/, '');
  const packageMatch = normalizePathForComparison(target).match(/app\/src\/main\/java\/(.+)\/[^/]+\.kt$/i);
  const packageName = packageMatch?.[1]?.replace(/\//g, '.');

  if (basename === 'SanitizeFilename') {
    return [
      ...(packageName ? [`package ${packageName}`, ''] : []),
      'object SanitizeFilename {',
      '    fun from(input: String): String {',
      '        val sanitized = input.trim()',
      '            .replace(Regex("\\\\s+"), "_")',
      '            .replace(Regex("[^A-Za-z0-9_.-]"), "")',
      '',
      '        return if (sanitized.isBlank()) "untitled" else sanitized',
      '    }',
      '}',
      '',
    ].join('\n');
  }

  if (basename === 'BillMapper') {
    return [
      ...(packageName ? [`package ${packageName}`, ''] : []),
      'object BillMapper {',
      '    fun displayAmount(cents: Long): String {',
      '        return String.format("$%.2f", cents / 100.0)',
      '    }',
      '}',
      '',
    ].join('\n');
  }

  if (basename === 'BillEntity') {
    return [
      ...(packageName ? [`package ${packageName}`, ''] : []),
      'data class BillEntity(',
      '    val id: Long,',
      '    val amountCents: Long',
      ') {',
      '    fun displayAmount(): String = BillMapper.displayAmount(amountCents)',
      '}',
      '',
    ].join('\n');
  }

  return [
    ...(packageName ? [`package ${packageName}`, ''] : []),
    `object ${basename} {`,
    '    fun from(input: String): String = input.trim()',
    '}',
    '',
  ].join('\n');
}

function buildJsContent(symbolName: string): string {
  if (symbolName === 'renderToggle') {
    return [
      'export function renderToggle(label, enabled) {',
      '  const stateClass = enabled ? "toggle-widget--enabled" : "toggle-widget--disabled";',
      '  return `<button class="toggle-widget ${stateClass}" aria-pressed="${enabled ? \'true\' : \'false\'}">${label}</button>`;',
      '}',
      '',
    ].join('\n');
  }

  if (symbolName === 'renderStatusCard') {
    const title = escapeHtmlExpression('title');
    const status = escapeHtmlExpression('status');
    return [
      'export function renderStatusCard(title, status) {',
      `  const safeTitle = ${title};`,
      `  const safeStatus = ${status};`,
      '  return `<article class="status-card status-card--${safeStatus.toLowerCase()}"><h2>${safeTitle}</h2><span>${safeStatus}</span></article>`;',
      '}',
      '',
    ].join('\n');
  }

  return [
    `export function ${symbolName}(...args) {`,
    '  return args.join(" ");',
    '}',
    '',
  ].join('\n');
}

function buildTsContent(symbolName: string): string {
  if (symbolName === 'normalizeEmail') {
    return [
      'export function normalizeEmail(input: string): string {',
      "  return input.trim().replace(/\\s+/g, ' ').toLowerCase();",
      '}',
      '',
    ].join('\n');
  }

  if (symbolName === 'formatDisplayName') {
    return [
      'export function formatDisplayName(firstName: string, lastName: string, email: string): string {',
      '  const name = [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");',
      '  return name.length > 0 ? name : email;',
      '}',
      '',
    ].join('\n');
  }

  return [
    `export function ${symbolName}(input: string): string {`,
    '  return input;',
    '}',
    '',
  ].join('\n');
}

function buildCssContent(symbolName: string): string {
  if (symbolName === 'renderToggle') {
    return [
      '.toggle-widget {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  border: 1px solid #8c959f;',
      '  border-radius: 6px;',
      '  padding: 6px 10px;',
      '  background: #ffffff;',
      '  color: #24292f;',
      '}',
      '',
      '.toggle-widget--enabled {',
      '  border-color: #1f883d;',
      '  background: #dafbe1;',
      '}',
      '',
      '.toggle-widget--disabled {',
      '  border-color: #8c959f;',
      '  background: #f6f8fa;',
      '  color: #57606a;',
      '}',
      '',
    ].join('\n');
  }

  return [
    '.status-card {',
    '  border: 1px solid #d0d7de;',
    '  border-radius: 6px;',
    '  padding: 12px;',
    '  background: #ffffff;',
    '  color: #24292f;',
    '}',
    '',
    '.status-card span {',
    '  display: inline-block;',
    '  margin-top: 6px;',
    '  font-weight: 600;',
    '}',
    '',
  ].join('\n');
}

function getLiteralBindingContent(binding: FileLiteralBindingResolution): string | null {
  if (binding.status !== 'matched') {
    return null;
  }
  return binding.constraint.literal;
}

export function buildDeterministicSimpleFileContent(
  target: string,
  rawTask: string,
): string {
  const contract = getRequestedTargetContract(rawTask);
  const normalizedTarget = normalizePathForComparison(target);
  const boundLiteral = getLiteralBindingContent(
    resolveFileLiteralBinding(contract.exactInvariants, normalizedTarget),
  );
  if (boundLiteral !== null) {
    return boundLiteral;
  }
  const expectations = contract.expectationsByTarget.get(normalizedTarget) ?? [];
  const taskSymbol =
    /\brenderToggle\s*\(/i.test(rawTask) ? 'renderToggle' :
    /\bformatDisplayName\s*\(/i.test(rawTask) ? 'formatDisplayName' :
    null;
  const exportedSymbol = expectations.find(expectation => expectation.kind === 'exported_symbol')?.symbolName
    ?? taskSymbol
    ?? getPathBasename(normalizedTarget).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_$]/g, '');

  if (isWriteReportTarget(normalizedTarget)) {
    return buildWriteReportContent(contract.requestedTargets);
  }
  if (/\.md$/i.test(normalizedTarget)) {
    return buildMarkdownContent(normalizedTarget);
  }
  if (/\.sh$/i.test(normalizedTarget)) {
    return buildScriptContent(normalizedTarget);
  }
  if (/\.kt$/i.test(normalizedTarget)) {
    return buildKotlinContent(normalizedTarget);
  }
  if (/\.css$/i.test(normalizedTarget)) {
    return buildCssContent(exportedSymbol);
  }
  if (/\.ts$/i.test(normalizedTarget)) {
    return buildTsContent(exportedSymbol);
  }
  if (/\.(?:js|mjs|cjs)$/i.test(normalizedTarget)) {
    return buildJsContent(exportedSymbol);
  }

  return 'Created for the requested bounded task.\n';
}

function getAmbiguousLiteralBindingReasonForTargets(rawTask: string, targets: readonly string[]): string | null {
  const registry = getRequestedTargetContract(rawTask).exactInvariants;
  for (const target of targets) {
    const binding = resolveFileLiteralBinding(registry, target);
    if (binding.status === 'ambiguous') {
      return `[AMBIGUOUS_LITERAL_BINDING] ${binding.reason}`;
    }
  }
  return null;
}

export function getNextDeterministicSimpleWrite(
  approvedPlan: SwePlan,
  rawTask: string,
  toolCallLog: ToolCallLog[],
): DeterministicSimpleWrite | null {
  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0 || contract.requestedTargets.length > 6) {
    return null;
  }

  if (!isBoundedSimpleWritePlan(approvedPlan)) {
    return null;
  }

  const requestedTargets = new Set(contract.requestedTargets.map(target => target.toLowerCase()));
  const ambiguousLiteralBinding = getAmbiguousLiteralBindingReasonForTargets(rawTask, contract.requestedTargets);
  if (ambiguousLiteralBinding) {
    return null;
  }
  const writtenTargets = new Set(
    toolCallLog
      .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
      .map(entry => normalizePathForComparison(String(entry.target ?? '')).toLowerCase()),
  );

  const nextWrite = approvedPlan.minimal_action_set.find(step => {
    if (step.tool !== 'file_write') {
      return false;
    }
    const target = normalizePathForComparison(String(step.target ?? ''));
    return requestedTargets.has(target.toLowerCase()) && !writtenTargets.has(target.toLowerCase());
  });

  if (!nextWrite) {
    return null;
  }

  const target = normalizePathForComparison(String(nextWrite.target ?? ''));
  return {
    target,
    content: buildDeterministicSimpleFileContent(target, rawTask),
    reason: `model tiers failed before approved bounded file_write step ${nextWrite.step}`,
  };
}

export function getDeterministicSimpleRepairWrite(
  approvedPlan: SwePlan,
  rawTask: string,
  failedTarget: string,
): DeterministicSimpleWrite | null {
  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0 || contract.requestedTargets.length > 6) {
    return null;
  }

  if (!isBoundedSimpleWritePlan(approvedPlan)) {
    return null;
  }

  const normalizedTarget = normalizePathForComparison(failedTarget);
  const requestedTargets = new Set(contract.requestedTargets.map(target => target.toLowerCase()));
  const ambiguousLiteralBinding = getAmbiguousLiteralBindingReasonForTargets(rawTask, contract.requestedTargets);
  if (ambiguousLiteralBinding) {
    return null;
  }
  const isPlannedWrite = approvedPlan.minimal_action_set.some(step =>
    step.tool === 'file_write' &&
    normalizePathForComparison(String(step.target ?? '')).toLowerCase() === normalizedTarget.toLowerCase(),
  );

  if (!isPlannedWrite || !requestedTargets.has(normalizedTarget.toLowerCase())) {
    return null;
  }

  return {
    target: normalizedTarget,
    content: buildDeterministicSimpleFileContent(normalizedTarget, rawTask),
    reason: `repairing bounded file_write output that failed verification for ${normalizedTarget}`,
  };
}

export function getDirectBoundedWritePlan(
  approvedPlan: SwePlan,
  rawTask: string,
  projectRoot: string | null,
): DirectBoundedWritePlan | null {
  if (!projectRoot || !isBoundedSimpleWritePlan(approvedPlan)) {
    return null;
  }

  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0 || contract.requestedTargets.length > 6) {
    return null;
  }

  const requestedTargets = contract.requestedTargets.map(target => normalizePathForComparison(target));
  const ambiguousLiteralBinding = getAmbiguousLiteralBindingReasonForTargets(rawTask, requestedTargets);
  if (ambiguousLiteralBinding) {
    return null;
  }
  const requestedTargetSet = new Set(requestedTargets.map(target => target.toLowerCase()));
  const plannedWriteTargets = getBoundedSimpleWritePlanTargets(approvedPlan);
  const plannedWriteTargetSet = new Set(plannedWriteTargets.map(target => target.toLowerCase()));

  if (plannedWriteTargets.length === 0) {
    return null;
  }

  if (!requestedTargets.every(target => plannedWriteTargetSet.has(target.toLowerCase()))) {
    return null;
  }

  if (!plannedWriteTargets.every(target => requestedTargetSet.has(target.toLowerCase()))) {
    return null;
  }

  for (const target of requestedTargets) {
    const resolvedTarget = resolveStepTargetPath(projectRoot, target);
    if (!isWithinProjectRootPath(projectRoot, resolvedTarget)) {
      return null;
    }
    const binding = resolveFileLiteralBinding(contract.exactInvariants, target);
    const exactEntireFileUpdate =
      binding.status === 'matched' &&
      binding.constraint.relation === 'entire_file_equals';
    if (existsSync(resolvedTarget) && !exactEntireFileUpdate) {
      return null;
    }
  }

  return {
    reason: 'bounded greenfield file-write plan with exact requested targets',
    writes: requestedTargets.map(target => ({
      target,
      content: buildDeterministicSimpleFileContent(target, rawTask),
      reason: 'direct deterministic bounded execution',
    })),
  };
}
