import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { EvidenceBundle } from '../evidence.js';
import {
  executeTool,
  ToolCallRequestSchema,
  type ToolResult,
} from '../localTools.js';
import type {
  OrchestratorManifest,
  ToolCallLog,
} from '../schemas/agentContracts.js';
import {
  buildHaltReport,
  canonicalizeExecutorTargetForLog,
  getTarget,
} from '../stages/executorHelpers.js';
import {
  buildDeterministicRootBuildGradleKtsContent,
  buildLocalPropertiesSdkLine,
  detectAndroidSdkStatus,
  detectCommandOnPath,
  detectGradleBinaryFromExtractedRoot,
  detectJavaRuntimeStatus,
  ensureAndroidSdkEnvironment,
  parseGradleDistributionUrl,
  prependProcessPath,
  repairSettingsGradleKtsContent,
} from '../stages/runtimePreflight.js';
import { inferProjectRoot } from './manifestContext.js';
import { BABEL_ROOT, GRADLE_CACHE_DIR } from './paths.js';


export async function runDeterministicAndroidSdkBootstrapLane(
  manifest: OrchestratorManifest,
): Promise<{ toolCallLog: ToolCallLog[]; haltedReport?: object }> {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return { toolCallLog: [] };
  }

  const toolCallLog: ToolCallLog[] = [];
  const recordSyntheticStep = (
    tool: ToolCallLog['tool'],
    target: string,
    exitCode: number,
    stdout: string,
    stderr = '',
  ): void => {
    toolCallLog.push({
      step: toolCallLog.length + 1,
      tool,
      target: canonicalizeExecutorTargetForLog(target, tool),
      exit_code: exitCode,
      stdout,
      stderr,
      verified: exitCode === 0,
    });
  };

  const sdkStatus = detectAndroidSdkStatus();
  if (!sdkStatus.available || !sdkStatus.sdkRoot) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length + 1,
        'Deterministic Android SDK bootstrap lane requires a usable Android SDK, but none was discovered in the executor environment.',
      ),
    };
  }

  const prependedPaths = ensureAndroidSdkEnvironment(sdkStatus);
  recordSyntheticStep(
    'directory_list',
    sdkStatus.sdkRoot,
    0,
    `Configured Android SDK environment from ${sdkStatus.sdkRoot}. PATH additions: ${prependedPaths.length > 0 ? prependedPaths.join(', ') : 'none'}`,
  );

  const localPropertiesPath = join(projectRoot, 'local.properties');
  const desiredSdkLine = buildLocalPropertiesSdkLine(sdkStatus.sdkRoot);
  const existingLocalProperties = existsSync(localPropertiesPath)
    ? readFileSync(localPropertiesPath, 'utf-8')
    : '';
  const existingLines = existingLocalProperties
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0 && !line.trim().startsWith('sdk.dir='));
  const nextLocalProperties = `${[desiredSdkLine, ...existingLines].join('\n')}\n`;

  if (existingLocalProperties !== nextLocalProperties) {
    writeFileSync(localPropertiesPath, nextLocalProperties, 'utf-8');
    recordSyntheticStep(
      'file_write',
      localPropertiesPath,
      0,
      `Wrote deterministic Android SDK local.properties using ${sdkStatus.sdkRoot}.`,
    );
  } else {
    recordSyntheticStep(
      'file_read',
      localPropertiesPath,
      0,
      `Reused existing local.properties with matching sdk.dir for ${sdkStatus.sdkRoot}.`,
    );
  }

  return { toolCallLog };
}

export async function runDeterministicGradleBootstrapLane(
  manifest: OrchestratorManifest,
  evidence: EvidenceBundle,
): Promise<{ toolCallLog: ToolCallLog[]; haltedReport?: object }> {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return { toolCallLog: [] };
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (existsSync(wrapperJarPath)) {
    return { toolCallLog: [] };
  }
  const settingsGradlePath = join(projectRoot, 'settings.gradle.kts');

  const toolCallLog: ToolCallLog[] = [];
  const recordSyntheticStep = (
    tool: ToolCallLog['tool'],
    target: string,
    exitCode: number,
    stdout: string,
    stderr = '',
  ): void => {
    toolCallLog.push({
      step: toolCallLog.length + 1,
      tool,
      target,
      exit_code: exitCode,
      stdout,
      stderr,
      verified: exitCode === 0,
    });
  };
  const executeLaneTool = async (
    req: z.infer<typeof ToolCallRequestSchema>,
  ): Promise<ToolResult> => {
    const stepNum = toolCallLog.length + 1;
    const toolResult = await executeTool(req, {
      agentId: 'bootstrap_lane',
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT
    });
    const entry: ToolCallLog = {
      step: stepNum,
      tool: req.tool,
      target: canonicalizeExecutorTargetForLog(getTarget(req), req.tool),
      exit_code: toolResult.exit_code,
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      ...(toolResult.denial ? { denial: toolResult.denial } : {}),
      ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
      ...(toolResult.checkpoint_ids ? { checkpoint_ids: toolResult.checkpoint_ids } : {}),
      verified: toolResult.exit_code === 0,
    };
    toolCallLog.push(entry);
    return toolResult;
  };

  const javaStatus = detectJavaRuntimeStatus();
  if (!javaStatus.available) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length + 1,
        'Deterministic Gradle bootstrap lane requires Java, but Java is unavailable in the executor environment.',
      ),
    };
  }

  const javaProbe = await executeLaneTool({
    tool: 'shell_exec',
    command: 'java -version',
    working_directory: projectRoot,
    timeout_seconds: 60,
  });
  if (javaProbe.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while verifying Java. stderr: ${javaProbe.stderr.slice(0, 200)}`,
      ),
    };
  }

  if (existsSync(settingsGradlePath)) {
    const settingsContent = readFileSync(settingsGradlePath, 'utf-8');
    const repairedSettings = repairSettingsGradleKtsContent(settingsContent);
    if (repairedSettings.changed) {
      writeFileSync(settingsGradlePath, repairedSettings.content, 'utf-8');
      recordSyntheticStep(
        'file_write',
        settingsGradlePath,
        0,
        `Applied deterministic settings.gradle.kts repair: ${repairedSettings.notes.join(' ')}`,
      );
    }
  }

  const rootBuildGradlePath = join(projectRoot, 'build.gradle.kts');
  if (!existsSync(rootBuildGradlePath)) {
    writeFileSync(
      rootBuildGradlePath,
      buildDeterministicRootBuildGradleKtsContent(),
      'utf-8',
    );
    recordSyntheticStep(
      'file_write',
      rootBuildGradlePath,
      0,
      'Created deterministic root build.gradle.kts with Android and Kotlin plugin versions for bootstrap.',
    );
  }

  let gradleStatus = detectCommandOnPath('gradle');
  if (!gradleStatus.available) {
    const propertiesRead = await executeLaneTool({
      tool: 'file_read',
      path: join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    });
    if (propertiesRead.exit_code !== 0) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length,
          `Deterministic Gradle bootstrap lane failed while reading gradle-wrapper.properties. stderr: ${propertiesRead.stderr.slice(0, 200)}`,
        ),
      };
    }

    const distributionUrl = parseGradleDistributionUrl(propertiesRead.stdout);
    if (!distributionUrl) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          'Deterministic Gradle bootstrap lane could not parse distributionUrl from gradle-wrapper.properties.',
        ),
      };
    }

    mkdirSync(GRADLE_CACHE_DIR, { recursive: true });
    const archiveName = distributionUrl.split('/').pop() ?? 'gradle-distribution.zip';
    const archivePath = join(GRADLE_CACHE_DIR, archiveName);
    const extractedRoot = join(
      GRADLE_CACHE_DIR,
      archiveName.replace(/\.zip$/i, ''),
    );

    if (!existsSync(archivePath)) {
      const response = await fetch(distributionUrl);
      if (!response.ok) {
        recordSyntheticStep(
          'file_write',
          archivePath,
          1,
          '',
          `Failed to download Gradle distribution from ${distributionUrl} (HTTP ${response.status}).`,
        );
        return {
          toolCallLog,
          haltedReport: buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            `Deterministic Gradle bootstrap lane failed while downloading Gradle from distributionUrl. HTTP ${response.status}.`,
          ),
        };
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(archivePath, archiveBuffer);
      recordSyntheticStep(
        'file_write',
        archivePath,
        0,
        `Cached Gradle distribution from ${distributionUrl} to ${archivePath}`,
      );
    } else {
      recordSyntheticStep(
        'file_read',
        archivePath,
        0,
        `Reusing cached Gradle distribution at ${archivePath}`,
      );
    }

    let gradleCandidate = detectGradleBinaryFromExtractedRoot(extractedRoot);
    if (!gradleCandidate) {
      mkdirSync(extractedRoot, { recursive: true });
      const tarResult = spawnSync(
        'tar',
        ['-xf', archivePath, '-C', extractedRoot],
        { encoding: 'utf-8', windowsHide: true },
      );
      recordSyntheticStep(
        'shell_exec',
        `tar -xf ${archivePath} -C ${extractedRoot}`,
        tarResult.status ?? 1,
        String(tarResult.stdout ?? ''),
        String(tarResult.stderr ?? ''),
      );
      if (tarResult.status !== 0) {
        return {
          toolCallLog,
          haltedReport: buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            `Deterministic Gradle bootstrap lane failed while extracting cached Gradle distribution. stderr: ${String(tarResult.stderr ?? '').slice(0, 200)}`,
          ),
        };
      }
      gradleCandidate = detectGradleBinaryFromExtractedRoot(extractedRoot);
    }

    if (!gradleCandidate) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          `Deterministic Gradle bootstrap lane extracted ${archiveName} but could not locate a Gradle binary in ${extractedRoot}.`,
        ),
      };
    }

    prependProcessPath(dirname(gradleCandidate));
    gradleStatus = detectCommandOnPath('gradle');
    if (!gradleStatus.available) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          'Deterministic Gradle bootstrap lane cached and extracted Gradle, but the gradle command is still unavailable on PATH.',
        ),
      };
    }
  }

  const gradleProbe = await executeLaneTool({
    tool: 'shell_exec',
    command: 'gradle --version',
    working_directory: projectRoot,
    timeout_seconds: 120,
  });
  if (gradleProbe.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while verifying Gradle. stderr: ${gradleProbe.stderr.slice(0, 200)}`,
      ),
    };
  }

  const wrapperResult = await executeLaneTool({
    tool: 'shell_exec',
    command: 'gradle wrapper',
    working_directory: projectRoot,
    timeout_seconds: 600,
  });
  if (wrapperResult.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while generating gradle-wrapper.jar. stderr: ${wrapperResult.stderr.slice(0, 200)}`,
      ),
    };
  }

  const wrapperListing = await executeLaneTool({
    tool: 'directory_list',
    path: join(projectRoot, 'gradle', 'wrapper'),
  });
  if (
    wrapperListing.exit_code !== 0 ||
    !existsSync(wrapperJarPath)
  ) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        'Deterministic Gradle bootstrap lane did not produce gradle-wrapper.jar after running gradle wrapper.',
      ),
    };
  }

  return { toolCallLog };
}
