import { executeTool } from '../localTools.js';
import { createToolExecutor } from './toolExecutor.js';

/** Keeps Chat reads raw so the Chat observation layer applies line windows once. */
export const chatReadToolExecutor = createToolExecutor({
  executeTool: (request, context) =>
    executeTool(
      request.tool === 'file_read' ? { ...request, raw: true } : request,
      context,
    ),
});
