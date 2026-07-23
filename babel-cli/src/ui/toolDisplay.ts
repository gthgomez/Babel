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
};

export function conversationalToolLabel(tool: string, target: string): string {
  const verb = TOOL_LABELS[tool] ?? tool;
  const short = target.length > 50 ? target.slice(0, 47) + '…' : target;
  return `${verb} ${dim(short)}`;
}