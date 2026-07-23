import { basename } from 'node:path';

import type {
  BenchmarkRuntimeCommandStatus,
  BenchmarkRuntimeInventory,
} from './benchmarkContainer.js';
import type { ExecutionProfileName } from './executionProfiles.js';

export type ToolCapabilityStatus =
  | 'none'
  | 'suggest_replacement'
  | 'blocked_missing_requirement'
  | 'blocked_no_allowed_implementation';

export interface ToolCapabilityImplementation {
  readonly commandTemplate: string;
  readonly requires: readonly string[];
  readonly description: string;
}

export interface ToolCapability {
  readonly id: string;
  readonly intent: string;
  readonly profiles: readonly ExecutionProfileName[];
  readonly risk: 'read_only' | 'verification' | 'mutation';
  readonly blockedCommandBases: readonly string[];
  readonly implementations: readonly ToolCapabilityImplementation[];
}

export interface ToolCapabilityResolution {
  readonly status: ToolCapabilityStatus;
  readonly capabilityId: string | null;
  readonly capabilityIntent: string | null;
  readonly originalCommand: string;
  readonly replacementCommand: string | null;
  readonly message: string;
  readonly suggestions: readonly string[];
  readonly missingRequirements: readonly string[];
}

export interface ToolCapabilityResolutionContext {
  readonly rawTask: string;
  readonly executionProfileName: ExecutionProfileName;
  readonly allowedCommandBases: readonly string[];
  readonly runtimeInventory?: BenchmarkRuntimeInventory | null | undefined;
}

export interface ToolCapabilityTraceEvent {
  readonly kind: 'capability_resolution';
  readonly status: ToolCapabilityStatus;
  readonly capability_id: string | null;
  readonly original_command: string;
  readonly replacement_command: string | null;
  readonly message: string;
  readonly missing_requirements: readonly string[];
}

export interface ToolCapabilitySnapshot {
  readonly id: string;
  readonly intent: string;
  readonly profiles: readonly ExecutionProfileName[];
  readonly risk: ToolCapability['risk'];
  readonly blockedCommandBases: readonly string[];
  readonly implementations: readonly ToolCapabilityImplementation[];
}

const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  {
    id: 'run.pytest_test_outputs',
    intent:
      'Run a pytest-style benchmark test_outputs.py file through pytest instead of plain Python.',
    profiles: ['benchmark_container'],
    risk: 'verification',
    blockedCommandBases: ['python', 'python3', 'py'],
    implementations: [
      {
        commandTemplate: 'python -m pytest -q {target}',
        requires: ['python', 'pytest'],
        description:
          'Execute pytest-style test functions that plain `python test_outputs.py` would not run.',
      },
    ],
  },
  {
    id: 'inspect.git_bundle',
    intent: 'Validate or inspect a Git bundle artifact with Git-native commands.',
    profiles: ['safe_repo', 'dev_local', 'benchmark_container'],
    risk: 'read_only',
    blockedCommandBases: ['file'],
    implementations: [
      {
        commandTemplate: 'git bundle verify {target}',
        requires: ['git'],
        description: 'Verify that the bundle is structurally valid and readable by Git.',
      },
      {
        commandTemplate: 'git bundle list-heads {target}',
        requires: ['git'],
        description: 'List bundle refs without relying on generic file-type inspection.',
      },
    ],
  },
  {
    id: 'inspect.tar_archive',
    intent: 'Inspect a tar archive using tar rather than a generic file-type probe.',
    profiles: ['safe_repo', 'dev_local', 'benchmark_container'],
    risk: 'read_only',
    blockedCommandBases: ['file'],
    implementations: [
      {
        commandTemplate: 'tar -tf {target}',
        requires: ['tar'],
        description: 'List archive contents as a verification-oriented inspection.',
      },
    ],
  },
  {
    id: 'inspect.gzip_stream',
    intent: 'Validate a gzip stream using gzip rather than a generic file-type probe.',
    profiles: ['safe_repo', 'dev_local', 'benchmark_container'],
    risk: 'read_only',
    blockedCommandBases: ['file'],
    implementations: [
      {
        commandTemplate: 'gzip -t {target}',
        requires: ['gzip'],
        description: 'Validate gzip structure with the tool that understands the format.',
      },
    ],
  },
];

function snapshotCapability(capability: ToolCapability): ToolCapabilitySnapshot {
  return {
    id: capability.id,
    intent: capability.intent,
    profiles: [...capability.profiles],
    risk: capability.risk,
    blockedCommandBases: [...capability.blockedCommandBases],
    implementations: capability.implementations.map((implementation) => ({
      commandTemplate: implementation.commandTemplate,
      requires: [...implementation.requires],
      description: implementation.description,
    })),
  };
}

export function getToolCapabilityRegistrySnapshot(
  executionProfileName?: ExecutionProfileName,
): ToolCapabilitySnapshot[] {
  return TOOL_CAPABILITIES.filter((capability) =>
    executionProfileName ? capability.profiles.includes(executionProfileName) : true,
  ).map(snapshotCapability);
}

function getCommandBase(rawCommand: string): string | null {
  const rawBase = rawCommand.trim().split(/\s+/).find(Boolean);
  if (!rawBase) {
    return null;
  }
  return basename(rawBase.replace(/\\/g, '/'))
    .replace(/\.(cmd|exe|bat)$/i, '')
    .toLowerCase();
}

function getFirstCommandArgument(rawCommand: string): string | null {
  const [, firstArg] = rawCommand.trim().split(/\s+/).filter(Boolean);
  return firstArg ?? null;
}

function taskOrCommandMentionsGitBundle(rawTask: string, rawCommand: string): boolean {
  return (
    /\bmerge-diff-arc-agi-task\b/i.test(rawTask) ||
    /\bgit\s+bundle\b/i.test(rawTask) ||
    /\.bundle\b/i.test(rawTask) ||
    /\.bundle\b/i.test(rawCommand)
  );
}

function getPytestStyleTestOutputsTarget(
  rawTask: string,
  rawCommand: string,
  commandBase: string,
): string | null {
  if (!/\bTerminal-Bench 2 task\b/i.test(rawTask)) {
    return null;
  }
  const parts = rawCommand.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  let candidates: string[] = [];
  if (['python', 'python3', 'py'].includes(commandBase)) {
    if (parts[1] === '-m' && parts[2] === 'pytest') {
      candidates = parts.slice(3);
    } else {
      candidates = [parts[1] ?? ''];
    }
  } else if (commandBase === 'pytest') {
    candidates = parts.slice(1);
  }

  const target = candidates
    .map((candidate) => candidate.replace(/^["']|["']$/g, ''))
    .find(
      (candidate) => basename(candidate.replace(/\\/g, '/')).toLowerCase() === 'test_outputs.py',
    );
  return target ?? null;
}

function matchCapability(
  rawCommand: string,
  context: ToolCapabilityResolutionContext,
): { capability: ToolCapability; target: string } | null {
  const commandBase = getCommandBase(rawCommand);
  if (!commandBase) {
    return null;
  }

  for (const capability of TOOL_CAPABILITIES) {
    if (!capability.profiles.includes(context.executionProfileName)) {
      continue;
    }
    if (!capability.blockedCommandBases.includes(commandBase)) {
      continue;
    }

    const pytestTarget =
      capability.id === 'run.pytest_test_outputs'
        ? getPytestStyleTestOutputsTarget(context.rawTask, rawCommand, commandBase)
        : null;
    if (pytestTarget) {
      return {
        capability,
        target: pytestTarget,
      };
    }

    const rawTarget = getFirstCommandArgument(rawCommand);
    if (!rawTarget) {
      continue;
    }
    const normalizedTarget = rawTarget.replace(/^["']|["']$/g, '');
    const lowerTarget = normalizedTarget.toLowerCase();
    if (
      capability.id === 'inspect.git_bundle' &&
      taskOrCommandMentionsGitBundle(context.rawTask, rawCommand)
    ) {
      return { capability, target: normalizedTarget };
    }
    if (capability.id === 'inspect.tar_archive' && /\.(?:tar|tgz|tar\.gz)$/i.test(lowerTarget)) {
      return { capability, target: normalizedTarget };
    }
    if (capability.id === 'inspect.gzip_stream' && /\.(?:gz|gzip)$/i.test(lowerTarget)) {
      return { capability, target: normalizedTarget };
    }
  }

  return null;
}

function getInventoryEntry(
  inventory: BenchmarkRuntimeInventory | null | undefined,
  commandBase: string,
): BenchmarkRuntimeCommandStatus | null {
  if (!inventory || inventory.status !== 'available') {
    return null;
  }
  return inventory.commands.find((entry) => entry.command === commandBase) ?? null;
}

function requirementIsUsable(
  requirement: string,
  context: ToolCapabilityResolutionContext,
): boolean {
  if (!context.allowedCommandBases.includes(requirement)) {
    return false;
  }

  if (context.executionProfileName !== 'benchmark_container') {
    return true;
  }

  const inventoryEntry = getInventoryEntry(context.runtimeInventory, requirement);
  return inventoryEntry ? inventoryEntry.available : true;
}

function missingRequirementsForImplementation(
  implementation: ToolCapabilityImplementation,
  context: ToolCapabilityResolutionContext,
): string[] {
  return implementation.requires.filter(
    (requirement) => !requirementIsUsable(requirement, context),
  );
}

function applyCommandTemplate(template: string, target: string): string {
  return template.replace(/\{target\}/g, target);
}

export function buildToolCapabilityPromptLines(
  executionProfileName: ExecutionProfileName,
): string[] {
  const profileCapabilities = TOOL_CAPABILITIES.filter((capability) =>
    capability.profiles.includes(executionProfileName),
  );
  if (profileCapabilities.length === 0) {
    return [];
  }

  return [
    'Tool capability broker:',
    '  - Plan in terms of capabilities first, raw commands second.',
    '  - If a generic inspection command is blocked, use the capability-specific replacement below instead of retrying alternate generic probes.',
    '  - If every implementation for a required capability is missing from the runtime inventory, halt or replan around the true missing capability. Do not copy unavailable replacement commands, install missing packages, or retry equivalent syntax. Do not substitute a different file format or unrelated command.',
    ...profileCapabilities.map((capability) => {
      const implementations = capability.implementations
        .map((implementation) => implementation.commandTemplate)
        .join(' OR ');
      return `  - ${capability.id}: ${capability.intent} Preferred command(s): ${implementations}.`;
    }),
  ];
}

export function resolveToolCapabilityForCommand(
  rawCommand: string,
  context: ToolCapabilityResolutionContext,
): ToolCapabilityResolution {
  const matched = matchCapability(rawCommand, context);
  if (!matched) {
    return {
      status: 'none',
      capabilityId: null,
      capabilityIntent: null,
      originalCommand: rawCommand,
      replacementCommand: null,
      message: 'No matching tool capability.',
      suggestions: [],
      missingRequirements: [],
    };
  }

  const { capability, target } = matched;
  const suggestions = capability.implementations.map(
    (implementation) =>
      `${applyCommandTemplate(implementation.commandTemplate, target)} - ${implementation.description}`,
  );

  for (const implementation of capability.implementations) {
    const missing = missingRequirementsForImplementation(implementation, context);
    if (missing.length === 0) {
      const replacementCommand = applyCommandTemplate(implementation.commandTemplate, target);
      return {
        status: 'suggest_replacement',
        capabilityId: capability.id,
        capabilityIntent: capability.intent,
        originalCommand: rawCommand,
        replacementCommand,
        message:
          `Command "${rawCommand}" maps to capability "${capability.id}". ` +
          `Use "${replacementCommand}" instead.`,
        suggestions,
        missingRequirements: [],
      };
    }
  }

  const missingRequirements = [
    ...new Set(
      capability.implementations.flatMap((implementation) =>
        missingRequirementsForImplementation(implementation, context),
      ),
    ),
  ];
  return {
    status:
      missingRequirements.length > 0
        ? 'blocked_missing_requirement'
        : 'blocked_no_allowed_implementation',
    capabilityId: capability.id,
    capabilityIntent: capability.intent,
    originalCommand: rawCommand,
    replacementCommand: null,
    message:
      `Command "${rawCommand}" maps to capability "${capability.id}", but no implementation ` +
      `is usable in the current execution profile. Missing or disallowed requirement(s): ` +
      `${missingRequirements.join(', ') || 'none'}.`,
    suggestions,
    missingRequirements,
  };
}

export function formatToolCapabilityResolutionForFeedback(
  resolution: ToolCapabilityResolution,
): string {
  if (resolution.status === 'none') {
    return '';
  }

  const suggestions =
    resolution.status === 'suggest_replacement' && resolution.suggestions.length > 0
      ? ` Suggestions: ${resolution.suggestions.join(' | ')}`
      : '';
  const missing =
    resolution.missingRequirements.length > 0
      ? ` Missing requirements: ${resolution.missingRequirements.join(', ')}.`
      : '';
  const blockedGuidance =
    resolution.status === 'blocked_missing_requirement' ||
    resolution.status === 'blocked_no_allowed_implementation'
      ? ' Do not retry the same capability with alternate syntax or install missing packages; choose an available source-only/custom check route or halt with the missing capability.'
      : '';
  return `[TOOL_CAPABILITY_BROKER] ${resolution.message}${missing}${blockedGuidance}${suggestions}`;
}

export function buildToolCapabilityTraceEvent(
  resolution: ToolCapabilityResolution,
): ToolCapabilityTraceEvent | null {
  if (resolution.status === 'none') {
    return null;
  }
  return {
    kind: 'capability_resolution',
    status: resolution.status,
    capability_id: resolution.capabilityId,
    original_command: resolution.originalCommand,
    replacement_command: resolution.replacementCommand,
    message: resolution.message,
    missing_requirements: resolution.missingRequirements,
  };
}
