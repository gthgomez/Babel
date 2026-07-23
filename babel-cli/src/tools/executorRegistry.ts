import type { ToolCallRequest, ToolContext } from '../localTools.js';
import type { ToolResult } from '../sandbox.js';

export const EXECUTOR_TOOL_CATEGORIES = [
  'filesystem',
  'process',
  'mcp',
  'ui',
  'memory',
  'mode',
  'search',
  'web',
  'plugin',
  'coordination',
  'vcs',
  'knowledge-graph',
] as const;

export type ExecutorToolCategory = (typeof EXECUTOR_TOOL_CATEGORIES)[number];
export type ExecutorToolName = ToolCallRequest['tool'];
export type ExecutorToolDryRunBehavior = 'live' | 'mocked' | 'shadow_write' | 'stateful';
export type ExecutorToolHandler = (
  req: ToolCallRequest,
  context: ToolContext,
) => ToolResult | Promise<ToolResult>;

export interface ExecutorToolInputContract {
  required: string[];
  optional: string[];
}

export interface ExecutorToolDefinition {
  name: ExecutorToolName;
  category: ExecutorToolCategory;
  description: string;
  mutating: boolean;
  dryRunBehavior: ExecutorToolDryRunBehavior;
  policyTags: string[];
  input: ExecutorToolInputContract;
  handler: ExecutorToolHandler;
}

export type ExecutorToolSnapshot = Omit<ExecutorToolDefinition, 'handler'>;

export interface ExecutorToolRegistry {
  list(): ExecutorToolSnapshot[];
  get(name: string): ExecutorToolDefinition | null;
  getSnapshot(name: string): ExecutorToolSnapshot | null;
  dispatch(req: ToolCallRequest, context: ToolContext): Promise<ToolResult>;
}

function snapshotTool(definition: ExecutorToolDefinition): ExecutorToolSnapshot {
  return {
    name: definition.name,
    category: definition.category,
    description: definition.description,
    mutating: definition.mutating,
    dryRunBehavior: definition.dryRunBehavior,
    policyTags: [...definition.policyTags],
    input: {
      required: [...definition.input.required],
      optional: [...definition.input.optional],
    },
  };
}

export function createExecutorToolRegistry(
  definitions: readonly ExecutorToolDefinition[],
): ExecutorToolRegistry {
  const definitionsByName = new Map<string, ExecutorToolDefinition>();

  for (const definition of definitions) {
    if (definitionsByName.has(definition.name)) {
      throw new Error(`Duplicate executor tool registration: ${definition.name}`);
    }
    definitionsByName.set(definition.name, definition);
  }

  return {
    list: () => definitions.map(snapshotTool),

    get: (name: string) => definitionsByName.get(name) ?? null,

    getSnapshot: (name: string) => {
      const definition = definitionsByName.get(name);
      return definition ? snapshotTool(definition) : null;
    },

    async dispatch(req: ToolCallRequest, context: ToolContext): Promise<ToolResult> {
      const definition = definitionsByName.get(req.tool);
      if (!definition) {
        return {
          exit_code: 1,
          stdout: '',
          stderr: `[TOOL_CALL_ERROR] Unknown tool: ${req.tool}`,
        };
      }

      return definition.handler(req, context);
    },
  };
}
