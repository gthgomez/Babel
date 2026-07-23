import type { SwePlan } from '../schemas/agentContracts.js';

const SHELL_CHAIN_SPLIT_RE = /&&/;

export function splitShellChain(command: string): string[] {
  if (!SHELL_CHAIN_SPLIT_RE.test(command)) {
    return [command.trim()].filter(Boolean);
  }
  return command
    .split(SHELL_CHAIN_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function splitChainedShellSteps(plan: SwePlan): SwePlan {
  const expanded: SwePlan['minimal_action_set'] = [];
  let stepNum = 1;

  for (const step of plan.minimal_action_set) {
    if (
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      typeof step.target === 'string'
    ) {
      const parts = splitShellChain(step.target);
      if (parts.length > 1) {
        for (const part of parts) {
          expanded.push({
            ...step,
            step: stepNum++,
            target: part,
            description: `${step.description} (split chain ${expanded.length + 1}/${parts.length})`,
          });
        }
        continue;
      }
    }
    expanded.push({ ...step, step: stepNum++ });
  }

  return {
    ...plan,
    minimal_action_set: expanded,
  };
}
