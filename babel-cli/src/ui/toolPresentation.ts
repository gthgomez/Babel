/**
 * Tool Presentation Formatter for Daily-Driver Terminal UI.
 *
 * Provides calm, concise, collapsed formatting for routine successful tool activity,
 * while automatically expanding errors, policy interventions, and verifier failures.
 * Fully width-aware across 60, 80, 100, 120, and 160 column breakpoints.
 */

import {
  success,
  error,
  warning,
  muted,
  info,
  dim,
  bold,
  truncate,
  visibleLength,
  getEffectiveTerminalWidth,
} from './theme.js';

export interface ToolExecutionSummary {
  tool: string;
  target: string;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  detail?: string | undefined;
  status?: 'success' | 'failure' | 'unknown' | undefined;
}

export interface CollapsedToolGroup {
  category: 'read' | 'search' | 'edit' | 'command' | 'verifier' | 'other';
  count: number;
  items: ToolExecutionSummary[];
  hasErrors: boolean;
  hasUnknowns: boolean;
}

export function isKnownFailureDetail(detail: string | undefined): boolean {
  if (!detail) return false;
  return (
    detail === 'blocked' ||
    detail === 'error' ||
    detail === 'failed' ||
    detail === 'degraded_suppressed' ||
    detail === 'platform_unusable' ||
    detail === 'hard-plan-mode' ||
    detail === 'plan-gate' ||
    detail === 'phase-gate' ||
    detail === 'reconciliation-required' ||
    (detail.startsWith('exit ') && !detail.startsWith('exit 0'))
  );
}

export function groupToolExecutions(
  executions: readonly ToolExecutionSummary[],
): CollapsedToolGroup[] {
  const groups: CollapsedToolGroup[] = [];

  for (const exec of executions) {
    let category: CollapsedToolGroup['category'] = 'other';
    const t = exec.tool.toLowerCase();

    if (t.includes('read') || t.includes('view') || t.includes('cat') || t.includes('head')) {
      category = 'read';
    } else if (t.includes('search') || t.includes('grep') || t.includes('find') || t.includes('list')) {
      category = 'search';
    } else if (t.includes('write') || t.includes('replace') || t.includes('patch') || t.includes('edit')) {
      category = 'edit';
    } else if (t.includes('test') || t.includes('verify')) {
      category = 'verifier';
    } else if (t.includes('command') || t.includes('exec') || t.includes('shell')) {
      category = 'command';
    }

    const isErr =
      exec.status === 'failure' ||
      (exec.exitCode !== undefined && exec.exitCode !== 0) ||
      Boolean(exec.error) ||
      isKnownFailureDetail(exec.detail);
    const isUnk =
      exec.status === 'unknown' ||
      (exec.exitCode === undefined && !isErr && exec.status !== 'success');

    // Group adjacent same-category executions unless they contain errors
    const lastGroup = groups.at(-1);
    if (lastGroup && lastGroup.category === category && !isErr && !lastGroup.hasErrors) {
      lastGroup.count += 1;
      lastGroup.items.push(exec);
      if (isUnk) lastGroup.hasUnknowns = true;
    } else {
      groups.push({
        category,
        count: 1,
        items: [exec],
        hasErrors: isErr,
        hasUnknowns: isUnk,
      });
    }
  }

  return groups;
}

export function formatToolGroupSummary(
  group: CollapsedToolGroup,
  verbose = false,
  width?: number,
): string {
  const termWidth = width ?? getEffectiveTerminalWidth();

  if (verbose || group.hasErrors) {
    // Expanded view for errors or verbose mode
    return group.items
      .map((item) => {
        const isErr =
          item.status === 'failure' ||
          (item.exitCode !== undefined && item.exitCode !== 0) ||
          Boolean(item.error) ||
          isKnownFailureDetail(item.detail);
        const isSuccess =
          item.status === 'success' ||
          (item.exitCode === 0 && !item.error && !isKnownFailureDetail(item.detail));
        const icon = isErr ? error('✖') : isSuccess ? success('✔') : muted('○');
        const statusText = isErr
          ? error(`failed (exit ${item.exitCode ?? 1})`)
          : isSuccess
            ? muted('ok')
            : muted('unverified');
        const errSuffix = item.error ? ` (${item.error})` : '';
        const rawLine = `  ${icon} ${dim(item.tool)} ${item.target} — ${statusText}${errSuffix}`;
        if (visibleLength(rawLine) > termWidth) {
          const staticLen = visibleLength(`  ${icon} ${dim(item.tool)}  — ${statusText}${errSuffix}`);
          const budget = Math.max(4, termWidth - staticLen);
          const truncatedTarget = truncate(item.target, budget);
          const fittedLine = `  ${icon} ${dim(item.tool)} ${truncatedTarget} — ${statusText}${errSuffix}`;
          return visibleLength(fittedLine) > termWidth ? truncate(fittedLine, termWidth) : fittedLine;
        }
        return rawLine;
      })
      .join('\n');
  }

  // Collapsed summary for routine activity
  let line = '';
  switch (group.category) {
    case 'read':
      line = group.hasUnknowns
        ? `  ${muted('○')} ${dim(`Read ${group.count} file${group.count > 1 ? 's' : ''} (unverified)`)}`
        : `  ${muted('○')} ${dim(`Read ${group.count} file${group.count > 1 ? 's' : ''}`)}`;
      break;
    case 'search':
      line = group.hasUnknowns
        ? `  ${muted('○')} ${dim(`Searched workspace (${group.count} step${group.count > 1 ? 's' : ''}, unverified)`)}`
        : `  ${muted('○')} ${dim(`Searched workspace (${group.count} step${group.count > 1 ? 's' : ''})`)}`;
      break;
    case 'edit':
      line = group.hasUnknowns
        ? `  ${muted('○')} ${dim(`Edited ${group.count} file${group.count > 1 ? 's' : ''} (unverified)`)}`
        : `  ${success('✔')} ${bold(`Edited ${group.count} file${group.count > 1 ? 's' : ''}`)}`;
      break;
    case 'verifier':
      line = group.hasUnknowns
        ? `  ${muted('○')} ${dim('Ran verifier (unverified)')}`
        : `  ${success('✔')} ${success('Ran tests & verifiers (exit 0)')}`;
      break;
    case 'command':
      line = group.hasUnknowns
        ? `  ${muted('○')} ${dim(`Executed ${group.count} command${group.count > 1 ? 's' : ''} (unverified)`)}`
        : `  ${muted('○')} ${dim(`Executed ${group.count} command${group.count > 1 ? 's' : ''}`)}`;
      break;
    default:
      line = group.hasUnknowns
        ? `  ${muted('○')} ${dim(`${group.items[0]?.tool ?? 'tool'} (${group.count}) (unverified)`)}`
        : `  ${muted('○')} ${dim(`${group.items[0]?.tool ?? 'tool'} (${group.count})`)}`;
      break;
  }

  if (visibleLength(line) > termWidth) {
    return truncate(line, termWidth);
  }
  return line;
}

export function renderToolExecutionTrail(
  executions: readonly ToolExecutionSummary[],
  verbose = false,
  width?: number,
): string {
  if (executions.length === 0) return '';
  const groups = groupToolExecutions(executions);
  return groups.map((g) => formatToolGroupSummary(g, verbose, width)).join('\n');
}
