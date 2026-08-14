/**
 * Tool Presentation Formatter for Daily-Driver Terminal UI.
 *
 * Provides calm, concise, collapsed formatting for routine successful tool activity,
 * while automatically expanding errors, policy interventions, and verifier failures.
 */

import { success, error, warning, muted, info, dim, bold } from './theme.js';

export interface ToolExecutionSummary {
  tool: string;
  target: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  detail?: string;
}

export interface CollapsedToolGroup {
  category: 'read' | 'search' | 'edit' | 'command' | 'verifier' | 'other';
  count: number;
  items: ToolExecutionSummary[];
  hasErrors: boolean;
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

    const hasError = exec.exitCode !== undefined && exec.exitCode !== 0 || Boolean(exec.error);

    // Group adjacent same-category executions unless they contain errors
    const lastGroup = groups.at(-1);
    if (lastGroup && lastGroup.category === category && !hasError && !lastGroup.hasErrors) {
      lastGroup.count += 1;
      lastGroup.items.push(exec);
    } else {
      groups.push({
        category,
        count: 1,
        items: [exec],
        hasErrors: hasError,
      });
    }
  }

  return groups;
}

export function formatToolGroupSummary(group: CollapsedToolGroup, verbose = false): string {
  if (verbose || group.hasErrors) {
    // Expanded view for errors or verbose mode
    return group.items
      .map((item) => {
        const isErr = (item.exitCode !== undefined && item.exitCode !== 0) || Boolean(item.error);
        const icon = isErr ? error('✖') : success('✔');
        const statusText = isErr ? error(`failed (exit ${item.exitCode ?? 1})`) : muted('ok');
        return `  ${icon} ${dim(item.tool)} ${item.target} — ${statusText}${item.error ? ` (${item.error})` : ''}`;
      })
      .join('\n');
  }

  // Collapsed summary for routine successful activity
  switch (group.category) {
    case 'read':
      return `  ${muted('○')} ${dim(`Read ${group.count} file${group.count > 1 ? 's' : ''}`)}`;
    case 'search':
      return `  ${muted('○')} ${dim(`Searched workspace (${group.count} step${group.count > 1 ? 's' : ''})`)}`;
    case 'edit':
      return `  ${success('✔')} ${bold(`Edited ${group.count} file${group.count > 1 ? 's' : ''}`)}`;
    case 'verifier':
      return `  ${success('✔')} ${success('Ran tests & verifiers (exit 0)')}`;
    case 'command':
      return `  ${muted('○')} ${dim(`Executed ${group.count} command${group.count > 1 ? 's' : ''}`)}`;
    default:
      return `  ${muted('○')} ${dim(`${group.items[0]?.tool ?? 'tool'} (${group.count})`)}`;
  }
}

export function renderToolExecutionTrail(
  executions: readonly ToolExecutionSummary[],
  verbose = false,
): string {
  if (executions.length === 0) return '';
  const groups = groupToolExecutions(executions);
  return groups.map((g) => formatToolGroupSummary(g, verbose)).join('\n');
}
