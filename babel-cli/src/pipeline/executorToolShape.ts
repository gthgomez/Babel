import type { ToolCallRequest } from '../localTools.js';

export function isExecutorToolShapePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return /^<[^>]+>$/.test(trimmed) &&
    /\b(project-relative|cmd-without|path|command|server_name|query|https:\/\/\.\.\.)\b/i.test(trimmed);
}

export function replaceExecutorRequestTarget(req: ToolCallRequest, target: string): ToolCallRequest {
  if (req.tool === 'directory_list' || req.tool === 'file_read' || req.tool === 'file_write') {
    return { ...req, path: target };
  }
  if (req.tool === 'shell_exec' || req.tool === 'test_run') {
    return { ...req, command: target };
  }
  return req;
}
