import {
  DEFAULT_EXECUTION_PROFILE,
  normalizeExecutionProfile,
  resolveExecutionProfile,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { getToolCapabilityRegistrySnapshot } from '../config/toolCapabilities.js';
import { getAllowedShellCommands } from '../sandbox.js';
import type { ExecutorToolSnapshot } from './executorRegistry.js';

export type ToolCatalogEntryKind = 'executor_tool' | 'capability';
export type ToolCatalogPolicyStatus = 'allowed' | 'disabled' | 'advisory';

export interface ToolCatalogPolicy {
  status: ToolCatalogPolicyStatus;
  reasons: string[];
}

export interface ToolCatalogEntry {
  kind: ToolCatalogEntryKind;
  name: string;
  category: string;
  description: string;
  mutating: boolean;
  risk: string;
  policy: ToolCatalogPolicy;
  profiles: string[];
  command_bases: string[];
  requirements: string[];
}

export interface ToolCatalogOptions {
  executionProfile?: string | null | undefined;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  includeCapabilities?: boolean;
}

function normalizeToolSet(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
  );
}

function resolveProfileName(raw: string | null | undefined): ExecutionProfileName {
  return normalizeExecutionProfile(raw) ?? DEFAULT_EXECUTION_PROFILE;
}

function policyForExecutorTool(
  tool: ExecutorToolSnapshot,
  options: ToolCatalogOptions,
): ToolCatalogPolicy {
  const allowedTools = normalizeToolSet(options.allowedTools);
  const disallowedTools = normalizeToolSet(options.disallowedTools);
  const toolName = tool.name.toLowerCase();
  const reasons: string[] = [];

  if (disallowedTools.has(toolName)) {
    reasons.push('disabled by run-level disallowed_tools');
  }
  if (allowedTools.size > 0 && !allowedTools.has(toolName)) {
    reasons.push('disabled because it is not in run-level allowed_tools');
  }

  const profile = resolveExecutionProfile(resolveProfileName(options.executionProfile));
  if (profile.disallowedTools.includes(toolName)) {
    reasons.push(`disabled by execution profile ${profile.name}`);
  }
  if (profile.allowedTools.length > 0 && !profile.allowedTools.includes(toolName)) {
    reasons.push(`disabled because execution profile ${profile.name} only allows selected tools`);
  }

  return {
    status: reasons.length > 0 ? 'disabled' : 'allowed',
    reasons: reasons.length > 0 ? reasons : ['allowed by current tool policy'],
  };
}

function executorToolCatalogEntry(
  tool: ExecutorToolSnapshot,
  options: ToolCatalogOptions,
): ToolCatalogEntry {
  return {
    kind: 'executor_tool',
    name: tool.name,
    category: tool.category,
    description: tool.description,
    mutating: tool.mutating,
    risk: tool.mutating ? 'mutation' : 'read_only',
    policy: policyForExecutorTool(tool, options),
    profiles: ['all'],
    command_bases: [],
    requirements: [],
  };
}

function capabilityCatalogEntries(options: ToolCatalogOptions): ToolCatalogEntry[] {
  const profileName = resolveProfileName(options.executionProfile);
  const allowedCommands = new Set(getAllowedShellCommands(profileName));
  return getToolCapabilityRegistrySnapshot().map((capability) => {
    const profileSupported = capability.profiles.includes(profileName);
    const requirements = [
      ...new Set(capability.implementations.flatMap((implementation) => implementation.requires)),
    ];
    const missingAllowedRequirements = requirements.filter(
      (requirement) => !allowedCommands.has(requirement),
    );
    const reasons = profileSupported
      ? missingAllowedRequirements.length > 0
        ? [
            `advisory only: missing allowlisted command base(s) ${missingAllowedRequirements.join(', ')}`,
          ]
        : ['available as a planning/executor rewrite capability']
      : [`not active for execution profile ${profileName}`];

    return {
      kind: 'capability' as const,
      name: capability.id,
      category: 'capability',
      description: capability.intent,
      mutating: capability.risk === 'mutation',
      risk: capability.risk,
      policy: {
        status: profileSupported ? ('advisory' as const) : ('disabled' as const),
        reasons,
      },
      profiles: [...capability.profiles],
      command_bases: [...capability.blockedCommandBases],
      requirements,
    };
  });
}

export function buildToolCatalog(
  executorTools: readonly ExecutorToolSnapshot[],
  options: ToolCatalogOptions = {},
): ToolCatalogEntry[] {
  const entries = executorTools.map((tool) => executorToolCatalogEntry(tool, options));
  if (options.includeCapabilities === true) {
    entries.push(...capabilityCatalogEntries(options));
  }
  return entries.sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
}

export function formatToolCatalogHuman(entries: readonly ToolCatalogEntry[]): string {
  return [
    'Tool catalog:',
    ...entries.map((entry) => {
      const policy =
        entry.policy.status === 'allowed'
          ? 'allowed'
          : `${entry.policy.status}: ${entry.policy.reasons.join('; ')}`;
      return `  ${entry.name.padEnd(24)} ${entry.kind.padEnd(13)} ${entry.risk.padEnd(10)} ${policy}`;
    }),
  ].join('\n');
}
