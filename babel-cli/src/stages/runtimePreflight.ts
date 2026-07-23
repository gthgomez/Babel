import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { OrchestratorManifest, SwePlan } from '../schemas/agentContracts.js';

export type JavaRuntimeStatus = {
  available: boolean;
  source: 'java_home' | 'path' | 'missing';
  summary: string;
};

export type AndroidSdkStatus = {
  available: boolean;
  source: 'android_home' | 'android_sdk_root' | 'local_default' | 'missing';
  sdkRoot: string | null;
  sdkManagerPath: string | null;
  adbPath: string | null;
  platforms: string[];
  buildTools: string[];
  summary: string;
};

export type CommandRuntimeStatus = {
  available: boolean;
  source: 'path' | 'missing';
  summary: string;
  command: string;
  resolvedPath: string | null;
};

export function detectCommandOnPath(command: string): CommandRuntimeStatus {
  const locatorCommand = process.platform === 'win32' ? 'where' : 'which';
  const locatorResult = spawnSync(locatorCommand, [command], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (locatorResult.status === 0) {
    const firstMatch = String(locatorResult.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstMatch) {
      return {
        available: true,
        source: 'path',
        summary: `${command} available on PATH (${firstMatch})`,
        command,
        resolvedPath: firstMatch,
      };
    }
  }

  return {
    available: false,
    source: 'missing',
    summary: `${command} is NOT available on PATH in the current executor environment.`,
    command,
    resolvedPath: null,
  };
}

export function detectGradleInstallCandidate(): string | null {
  const roots =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Gradle', 'C:\\Program Files (x86)\\Gradle']
      : ['/opt/gradle', '/usr/local/gradle'];

  const candidates: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          join(root, entry.name, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle'),
        )
        .filter((candidate) => existsSync(candidate))
        .sort((left, right) => right.localeCompare(left));
      candidates.push(...entries);
    } catch {
      continue;
    }
  }

  return candidates[0] ?? null;
}

export function prependProcessPath(pathEntry: string): void {
  const currentPath = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const normalizedEntry = resolve(pathEntry);
  const existing = currentPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const alreadyPresent = existing.some((entry) =>
    process.platform === 'win32'
      ? entry.toLowerCase() === normalizedEntry.toLowerCase()
      : entry === normalizedEntry,
  );
  if (alreadyPresent) {
    return;
  }

  process.env.PATH = [normalizedEntry, ...existing].join(delimiter);
}

export function parseGradleDistributionUrl(propertiesContent: string): string | null {
  const match = String(propertiesContent ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('distributionUrl='));
  if (!match) {
    return null;
  }

  return match.slice('distributionUrl='.length).trim().replace(/\\:/g, ':').replace(/\\=/g, '=');
}

export function detectGradleBinaryFromExtractedRoot(extractedRoot: string): string | null {
  const binaryName = process.platform === 'win32' ? 'gradle.bat' : 'gradle';
  const directCandidate = join(extractedRoot, 'bin', binaryName);
  if (existsSync(directCandidate)) {
    return directCandidate;
  }

  if (!existsSync(extractedRoot)) {
    return null;
  }

  try {
    const entries = readdirSync(extractedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(extractedRoot, entry.name, 'bin', binaryName))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => right.localeCompare(left));
    return entries[0] ?? null;
  } catch {
    return null;
  }
}

export function repairSettingsGradleKtsContent(content: string): {
  content: string;
  changed: boolean;
  notes: string[];
} {
  let next = String(content ?? '');
  const notes: string[] = [];

  const includeBareStringRe = /^(\s*)include\s+"([^"]+)"\s*$/gm;
  if (includeBareStringRe.test(next)) {
    next = next.replace(includeBareStringRe, '$1include("$2")');
    notes.push('Normalized bare include syntax to include("...").');
  }

  return {
    content: next,
    changed: notes.length > 0,
    notes,
  };
}

export function buildDeterministicRootBuildGradleKtsContent(): string {
  return [
    'plugins {',
    '    id("com.android.application") version "8.7.3" apply false',
    '    id("org.jetbrains.kotlin.android") version "1.9.24" apply false',
    '}',
    '',
  ].join('\n');
}

export function detectJavaRuntimeStatus(): JavaRuntimeStatus {
  const javaHome = process.env.JAVA_HOME?.trim();
  if (javaHome) {
    const javaHomeCandidate = join(
      javaHome,
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java',
    );
    if (existsSync(javaHomeCandidate)) {
      return {
        available: true,
        source: 'java_home',
        summary: `Java available via JAVA_HOME (${javaHomeCandidate})`,
      };
    }
  }

  const javaPathStatus = detectCommandOnPath('java');
  if (javaPathStatus.available) {
    return {
      available: true,
      source: 'path',
      summary: `Java available on PATH (${javaPathStatus.resolvedPath})`,
    };
  }

  return {
    available: false,
    source: 'missing',
    summary:
      'Java is NOT available in the current executor environment. JAVA_HOME is unset or invalid and no java executable is on PATH.',
  };
}

function listDirectoryNamesIfPresent(dirPath: string): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function detectAndroidSdkStatus(): AndroidSdkStatus {
  const candidates: Array<{ source: AndroidSdkStatus['source']; root: string | null }> = [
    { source: 'android_home', root: process.env.ANDROID_HOME?.trim() ?? null },
    { source: 'android_sdk_root', root: process.env.ANDROID_SDK_ROOT?.trim() ?? null },
    {
      source: 'local_default',
      root: process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.root || !existsSync(candidate.root)) {
      continue;
    }

    const platforms = listDirectoryNamesIfPresent(join(candidate.root, 'platforms'));
    const buildTools = listDirectoryNamesIfPresent(join(candidate.root, 'build-tools'));
    const platformToolsDir = join(candidate.root, 'platform-tools');
    const toolsBinDir = join(candidate.root, 'tools', 'bin');
    const adbPath = existsSync(
      join(platformToolsDir, process.platform === 'win32' ? 'adb.exe' : 'adb'),
    )
      ? join(platformToolsDir, process.platform === 'win32' ? 'adb.exe' : 'adb')
      : null;
    const sdkManagerPath = existsSync(
      join(toolsBinDir, process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'),
    )
      ? join(toolsBinDir, process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager')
      : null;

    if (platforms.length > 0 && buildTools.length > 0) {
      return {
        available: true,
        source: candidate.source,
        sdkRoot: candidate.root,
        sdkManagerPath,
        adbPath,
        platforms,
        buildTools,
        summary: `Android SDK available via ${candidate.source} (${candidate.root}); platforms=${platforms.join(', ') || 'none'}; build-tools=${buildTools.join(', ') || 'none'}`,
      };
    }
  }

  return {
    available: false,
    source: 'missing',
    sdkRoot: null,
    sdkManagerPath: null,
    adbPath: null,
    platforms: [],
    buildTools: [],
    summary:
      'Android SDK is NOT available in the executor environment. ANDROID_HOME / ANDROID_SDK_ROOT are unset or invalid and no usable local SDK was discovered.',
  };
}

export function buildLocalPropertiesSdkLine(sdkRoot: string): string {
  return `sdk.dir=${sdkRoot.replace(/\\/g, '\\\\')}`;
}

export function ensureAndroidSdkEnvironment(sdkStatus: AndroidSdkStatus): string[] {
  if (!sdkStatus.available || !sdkStatus.sdkRoot) {
    return [];
  }

  process.env.ANDROID_HOME = sdkStatus.sdkRoot;
  process.env.ANDROID_SDK_ROOT = sdkStatus.sdkRoot;

  const prependedPaths: string[] = [];
  for (const dirPath of [
    join(sdkStatus.sdkRoot, 'platform-tools'),
    join(sdkStatus.sdkRoot, 'tools', 'bin'),
    join(sdkStatus.sdkRoot, 'emulator'),
  ]) {
    if (existsSync(dirPath)) {
      prependProcessPath(dirPath);
      prependedPaths.push(dirPath);
    }
  }

  return prependedPaths;
}

export function usesGradleLikeCommand(target: string): boolean {
  return /\b(?:gradle|gradlew(?:\.bat)?)\b/i.test(String(target ?? ''));
}

export function isGradleProvisioningStep(step: SwePlan['minimal_action_set'][number]): boolean {
  if (step.tool !== 'shell_exec' && step.tool !== 'test_run') {
    return false;
  }

  const target = String(step.target ?? '').trim();
  if (!target) {
    return false;
  }

  return /\b(winget|choco|scoop)\b.*\bgradle\b/i.test(target);
}

export function shouldUseDeterministicGradleBootstrapLane(
  projectRoot: string | undefined,
): boolean {
  if (!projectRoot || !existsSync(projectRoot)) {
    return false;
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const gradlewPath = join(projectRoot, 'gradlew');
  const gradlewBatPath = join(projectRoot, 'gradlew.bat');
  const wrapperPropertiesPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');

  return (
    !existsSync(wrapperJarPath) &&
    existsSync(wrapperPropertiesPath) &&
    (existsSync(gradlewPath) || existsSync(gradlewBatPath))
  );
}

export function shouldUseDeterministicAndroidSdkBootstrapLane(
  projectRoot: string | undefined,
): boolean {
  if (!projectRoot || !existsSync(projectRoot)) {
    return false;
  }

  return (
    existsSync(join(projectRoot, 'settings.gradle.kts')) ||
    existsSync(join(projectRoot, 'app', 'build.gradle.kts')) ||
    existsSync(join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml'))
  );
}

export function isJavaProvisioningStep(step: SwePlan['minimal_action_set'][number]): boolean {
  if (step.tool !== 'shell_exec' && step.tool !== 'test_run') {
    return false;
  }

  const target = String(step.target ?? '').trim();
  if (!target) {
    return false;
  }

  return (
    /\b(winget|choco|scoop)\b.*\b(jdk|java|temurin|openjdk|corretto|microsoft-openjdk)\b/i.test(
      target,
    ) ||
    /\b(setx|export)\b[^\r\n]*\bJAVA_HOME\b/i.test(target) ||
    /\bJAVA_HOME\s*=/.test(target) ||
    /\bgradle\s+wrapper\b/i.test(target)
  );
}

export function projectRootFromManifest(manifest: OrchestratorManifest): string | undefined {
  const candidate = manifest.target_project_path?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}
