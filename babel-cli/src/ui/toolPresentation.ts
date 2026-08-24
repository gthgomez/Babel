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
  dim,
  bold,
  truncate,
  visibleLength,
  getEffectiveTerminalWidth,
} from './theme.js';
import {
  classifyToolPresentation,
  type ToolPresentationStatus,
} from './toolPresentationClassify.js';

export { isKnownFailureDetail, classifyToolPresentation } from './toolPresentationClassify.js';

export interface ToolExecutionSummary {
  tool: string;
  target: string;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  detail?: string | undefined;
  status?: ToolPresentationStatus | undefined;
}

export interface CollapsedToolGroup {
  category: 'read' | 'search' | 'edit' | 'command' | 'verifier' | 'other';
  count: number;
  items: ToolExecutionSummary[];
  hasErrors: boolean;
  hasBlocked: boolean;
  hasUnknowns: boolean;
}

function classifySummary(item: ToolExecutionSummary) {
  return classifyToolPresentation({
    detail: item.detail,
    error: item.error,
    exitCode: item.exitCode,
    status: item.status,
  });
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

    const cls = classifySummary(exec);
    const isErr = cls.isFailure;
    const isBlocked = cls.isBlocked || cls.availability === 'unavailable';
    const isUnk = cls.status === 'unknown' && !isBlocked;

    const lastGroup = groups.at(-1);
    if (
      lastGroup &&
      lastGroup.category === category &&
      !isErr &&
      !isBlocked &&
      !lastGroup.hasErrors &&
      !lastGroup.hasBlocked
    ) {
      lastGroup.count += 1;
      lastGroup.items.push(exec);
      if (isUnk) lastGroup.hasUnknowns = true;
    } else {
      groups.push({
        category,
        count: 1,
        items: [exec],
        hasErrors: isErr,
        hasBlocked: isBlocked,
        hasUnknowns: isUnk,
      });
    }
  }

  return groups;
}

function formatExpandedItem(item: ToolExecutionSummary, termWidth: number): string {
  const cls = classifySummary(item);
  let icon: string;
  let statusText: string;

  if (cls.isBlocked) {
    const reason = item.detail && item.detail !== 'blocked' ? item.detail : 'blocked';
    icon = warning('⏸');
    statusText = warning(reason);
  } else if (cls.availability === 'unavailable') {
    icon = warning('⏸');
    statusText = warning(item.detail ?? 'unavailable');
  } else if (cls.isFailure) {
    icon = error('✖');
    statusText = error(`failed (exit ${item.exitCode ?? 1})`);
  } else if (cls.isSuccess) {
    icon = success('✔');
    statusText = muted('ok');
  } else {
    icon = muted('○');
    statusText = muted('unverified');
  }

  const errSuffix = cls.isFailure && item.error ? ` (${item.error})` : '';
  const rawLine = `  ${icon} ${dim(item.tool)} ${item.target} — ${statusText}${errSuffix}`;
  if (visibleLength(rawLine) > termWidth) {
    const staticLen = visibleLength(`  ${icon} ${dim(item.tool)}  — ${statusText}${errSuffix}`);
    const budget = Math.max(4, termWidth - staticLen);
    const truncatedTarget = truncate(item.target, budget);
    const fittedLine = `  ${icon} ${dim(item.tool)} ${truncatedTarget} — ${statusText}${errSuffix}`;
    return visibleLength(fittedLine) > termWidth ? truncate(fittedLine, termWidth) : fittedLine;
  }
  return rawLine;
}

export function formatToolGroupSummary(
  group: CollapsedToolGroup,
  verbose = false,
  width?: number,
): string {
  const termWidth = width ?? getEffectiveTerminalWidth();

  if (verbose || group.hasErrors || group.hasBlocked) {
    return group.items.map((item) => formatExpandedItem(item, termWidth)).join('\n');
  }

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
