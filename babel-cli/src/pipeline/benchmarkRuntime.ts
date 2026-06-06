import type { ExecutionProfileName } from '../config/executionProfiles.js';
import {
  formatBenchmarkRuntimeInventoryPromptLines,
  getCachedBenchmarkContainerRuntimeInventory,
  inspectBenchmarkContainerRuntime,
  shouldUseBenchmarkContainerExecution,
  type BenchmarkRuntimeInventory,
} from '../config/benchmarkContainer.js';
import { resolveToolCapabilityForCommand } from '../config/toolCapabilities.js';
import { getAllowedShellCommands } from '../sandbox.js';

export function getBenchmarkRuntimeInventoryLines(
  executionProfileName: ExecutionProfileName,
  inspectIfMissing = true,
): string[] {
  const dockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '';
  if (!shouldUseBenchmarkContainerExecution(executionProfileName, dockerImage)) {
    return [];
  }

  const inventory = getCachedBenchmarkContainerRuntimeInventory(dockerImage) ??
    (inspectIfMissing ? inspectBenchmarkContainerRuntime(dockerImage) : null);
  if (!inventory) {
    return [];
  }

  return formatBenchmarkRuntimeInventoryPromptLines(
    inventory,
    getAllowedShellCommands(executionProfileName),
  );
}

export function getBenchmarkRuntimeInventoryForProfile(
  executionProfileName: ExecutionProfileName,
  inspectIfMissing = false,
): BenchmarkRuntimeInventory | null {
  const dockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '';
  if (!shouldUseBenchmarkContainerExecution(executionProfileName, dockerImage)) {
    return null;
  }

  return getCachedBenchmarkContainerRuntimeInventory(dockerImage) ??
    (inspectIfMissing ? inspectBenchmarkContainerRuntime(dockerImage) : null);
}

export function resolveShellCommandCapability(
  command: string,
  rawTask: string,
  executionProfileName: ExecutionProfileName,
  runtimeInventory: BenchmarkRuntimeInventory | null = getBenchmarkRuntimeInventoryForProfile(executionProfileName),
) {
  return resolveToolCapabilityForCommand(command, {
    rawTask,
    executionProfileName,
    allowedCommandBases: getAllowedShellCommands(executionProfileName),
    runtimeInventory,
  });
}

export function shouldApplyHostWindowsExecutorNotes(
  executionProfileName: ExecutionProfileName,
  dockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '',
): boolean {
  return process.platform === 'win32' &&
    !shouldUseBenchmarkContainerExecution(executionProfileName, dockerImage);
}
