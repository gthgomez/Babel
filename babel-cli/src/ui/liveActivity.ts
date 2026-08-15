/**
 * High-level live activity from real runtime events only.
 * Never fabricates progress the runtime did not report.
 */

export type LiveActivityKind =
  | 'thinking'
  | 'reading'
  | 'editing'
  | 'shell'
  | 'verification'
  | 'waiting'
  | 'cancelled';

export interface LiveActivityEvent {
  type?: string;
  tool?: string;
  target?: string | undefined;
  phase?: string;
  status?: string;
  cancelled?: boolean;
  blocked?: boolean;
  thinking?: boolean;
}

const READ_TOOLS = /^(read_file|read|grep|search|glob|list_dir|repo_map|semantic_search)$/i;
const EDIT_TOOLS = /^(write_file|str_replace|apply_patch|file_write|edit|delete_file)$/i;
const SHELL_TOOLS = /^(run_command|shell_exec|bash|await_command)$/i;
const VERIFY_TOOLS = /^(verify|run_tests|typecheck|lint|npm_test)$/i;

export function classifyLiveActivity(event: LiveActivityEvent): LiveActivityKind | null {
  if (!event || Object.keys(event).length === 0) return null;
  if (event.cancelled || event.status === 'cancelled' || event.type === 'cancelled') {
    return 'cancelled';
  }
  if (event.blocked || event.status === 'blocked' || event.type === 'blocked') {
    return 'waiting';
  }
  if (event.thinking || event.phase === 'thinking' || event.type === 'thinking') {
    return 'thinking';
  }
  const tool = event.tool ?? '';
  const type = event.type ?? '';
  const blob = `${tool} ${type}`.trim();
  if (!blob) return null;
  if (VERIFY_TOOLS.test(tool) || /verif/i.test(blob)) return 'verification';
  if (EDIT_TOOLS.test(tool) || /edit|write|patch/i.test(type)) return 'editing';
  if (SHELL_TOOLS.test(tool) || /shell|command/i.test(type)) return 'shell';
  if (READ_TOOLS.test(tool) || /read|search|grep/i.test(type)) return 'reading';
  // Unknown tool/type must fail neutral — never a confident Running/shell label.
  return null;
}

const LABELS: Record<LiveActivityKind, string> = {
  thinking: 'Thinking',
  reading: 'Inspecting',
  editing: 'Editing',
  shell: 'Running',
  verification: 'Verifying',
  waiting: 'Waiting',
  cancelled: 'Cancelled',
};

export function formatLiveActivity(
  kind: LiveActivityKind,
  targets: string[] = [],
): string {
  const label = LABELS[kind];
  const unique = [...new Set(targets.filter(Boolean))].slice(0, 4);
  if (unique.length === 0) return `● ${label}`;
  const kids = unique.map((t, i) => {
    const branch = i === unique.length - 1 ? '└─' : '├─';
    return `  ${branch} ${t}`;
  });
  return [`● ${label}`, ...kids].join('\n');
}

export function activityFromToolCall(tool: string, target?: string): {
  kind: LiveActivityKind;
  line: string;
} | null {
  const kind = classifyLiveActivity(target !== undefined ? { tool, target } : { tool });
  if (!kind) return null;
  return { kind, line: formatLiveActivity(kind, target ? [target] : []) };
}

let lastActivity: { kind: LiveActivityKind; line: string } | null = null;

/** Record a real runtime event for the default live-activity line. */
export function recordLiveActivity(event: LiveActivityEvent): LiveActivityKind | null {
  const kind = classifyLiveActivity(event);
  if (!kind) return lastActivity?.kind ?? null;
  const target = event.target;
  lastActivity = {
    kind,
    line: formatLiveActivity(kind, target ? [target] : []),
  };
  return kind;
}

export function getLastLiveActivity(): { kind: LiveActivityKind; line: string } | null {
  return lastActivity;
}

export function resetLiveActivityForTests(): void {
  lastActivity = null;
}
