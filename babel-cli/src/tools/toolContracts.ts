export const EXECUTOR_TOOL_NAMES = [
  'directory_list',
  'file_read',
  'file_write',
  'shell_exec',
  'test_run',
  'mcp_request',
  'mcp_resource_list',
  'mcp_resource_read',
  'mcp_prompt_list',
  'mcp_prompt_get',
  'mcp_tool_search',
  'web_search',
  'web_fetch',
  'plugin_tool',
  'audit_ui',
  'memory_store',
  'memory_query',
  'enter_plan_mode',
  'exit_plan_mode',
  'semantic_search',
  'acquire_lock',
  'release_lock',
] as const;

export type ExecutorToolName = typeof EXECUTOR_TOOL_NAMES[number];

export const MUTATING_EXECUTOR_TOOL_NAMES = [
  'file_write',
  'shell_exec',
  'test_run',
  'memory_store',
  'enter_plan_mode',
  'exit_plan_mode',
  'acquire_lock',
  'release_lock',
] as const satisfies readonly ExecutorToolName[];
