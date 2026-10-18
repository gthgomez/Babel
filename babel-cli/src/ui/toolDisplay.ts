import { dim } from './theme.js';

export const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading',
  list_dir: 'Listing',
  write_file: 'Editing',
  grep: 'Searching',
  glob: 'Finding',
  run_command: 'Running',
  apply_patch: 'Patching',
  web_search: 'Searching web',
  web_fetch: 'Fetching',
  sub_agent: 'Investigating',
  finish: 'Complete',
  file_read: 'Reading',
  directory_list: 'Listing',
  semantic_search: 'Searching',
  file_write: 'Editing',
  shell_exec: 'Running',
  test_run: 'Testing',
  verifier: 'Verifying',
  mcp_request: 'Calling',
  read_range: 'Reading',
  todo_write: 'Updating plan',
  git_context: 'Inspecting git',
};

export function conversationalToolLabel(
  tool: string,
  target: string,
  maxTargetLen = 50,
): string {
  const verb = TOOL_LABELS[tool] ?? tool;
  const cap = Math.max(8, maxTargetLen);
  const short = target.length > cap ? `${target.slice(0, Math.max(1, cap - 1))}…` : target;
  return `${verb} ${dim(short)}`;
}