import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  OrchestratorManifest,
  QaVerdict,
  SwePlan,
} from '../schemas/agentContracts.js';
import {
  shouldUseDeterministicAndroidSdkBootstrapLane,
  shouldUseDeterministicGradleBootstrapLane,
} from '../stages/runtimePreflight.js';
import { inferProjectRoot } from './manifestContext.js';

export function sanitizeQaVerdictForDeterministicGradleBootstrapLane(
  verdict: QaVerdict,
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): QaVerdict {
  if (
    verdict.verdict !== 'REJECT' ||
    !shouldUseDeterministicGradleBootstrapLane(inferProjectRoot(manifest))
  ) {
    return verdict;
  }

  const usesForbiddenGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')),
  );

  if (usesForbiddenGlobalGradle) {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    if (
      failure.tag === 'SFDIPOT-P' &&
      /gradle is not available on path/i.test(condition) &&
      /gradlew/i.test(condition)
    ) {
      return false;
    }

    if (
      failure.tag === 'NAMIT-N' &&
      /gradle-wrapper\.jar generation fails during bootstrap/i.test(condition)
    ) {
      return false;
    }

    return true;
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Deterministic Gradle bootstrap lane owns Gradle provisioning and wrapper-generation failure handling for this plan.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

export function sanitizeWindowsGradlewPermissionQaVerdict(
  verdict: QaVerdict,
  swePlan: SwePlan,
): QaVerdict {
  void swePlan;

  if (process.platform !== 'win32' || verdict.verdict !== 'REJECT') {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    return !(
      failure.tag === 'SFDIPOT-P' &&
      /\bgradlew(?:\.bat)?\b/i.test(condition) &&
      (
        /permission/i.test(condition) ||
        /mark of the web/i.test(condition) ||
        /unblock-file/i.test(condition) ||
        /executable permissions/i.test(condition)
      )
    );
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Windows wrapper-permission rejection removed because no grounded evidence showed gradlew / gradlew.bat was blocked.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

export function sanitizeExistingWrapperQaVerdict(
  verdict: QaVerdict,
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): QaVerdict {
  if (verdict.verdict !== 'REJECT') {
    return verdict;
  }

  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return verdict;
  }

  const wrapperExists =
    existsSync(join(projectRoot, 'gradlew')) ||
    existsSync(join(projectRoot, 'gradlew.bat'));
  const usesGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')),
  );

  if (!wrapperExists || usesGlobalGradle) {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    return !(
      failure.tag === 'SFDIPOT-P' &&
      /gradle (?:wrapper )?execution steps/i.test(condition) &&
      /not available on path/i.test(condition)
    );
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Existing gradlew / gradlew.bat wrapper allows wrapper-based execution without requiring global gradle on PATH.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

export function sanitizeGroundingViolationsForAndroidSdkLane(
  violations: string[],
  manifest: OrchestratorManifest,
): string[] {
  if (!shouldUseDeterministicAndroidSdkBootstrapLane(inferProjectRoot(manifest))) {
    return violations;
  }

  return violations.filter(condition => !/references missing path: .*local\.properties/i.test(condition));
}
