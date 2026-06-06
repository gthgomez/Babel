import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import { detectRuntimeVerificationTargetType } from './runtimeVerificationRunner.js';

export type GodotScaffoldSeedStatus =
  | 'SEEDED'
  | 'NOOP'
  | 'FAILED'
  | 'SKIPPED_WITH_REASON';

export interface GodotScaffoldSeedResult {
  stage: 'godot_scaffold_seed';
  targetType: 'godot' | 'unknown';
  targetRoot: string | null;
  scaffoldTemplate: string | null;
  filesCopied: string[];
  filesSkipped: string[];
  status: GodotScaffoldSeedStatus;
  reason: string;
  timestamp: string;
}

export interface GodotScaffoldSeedInput {
  rawTask: string;
  projectRoot: string | null;
  toolCallLog?: readonly ToolCallLog[];
  babelRoot?: string;
  scaffoldTemplate?: string;
  now?: () => Date;
}

export const GODOT_MOBILE_SCAFFOLD_FILES = [
  'project.godot',
  'scenes/Main.tscn',
  'scripts/Main.gd',
  'export_presets.cfg',
  'README.md',
] as const;

export function defaultGodotMobileScaffoldTemplate(babelRoot: string): string {
  return join(babelRoot, 'templates', 'godot-mobile-2d');
}

function isDirectoryEmpty(path: string): boolean {
  if (!existsSync(path)) {
    return true;
  }
  return statSync(path).isDirectory() && readdirSync(path).length === 0;
}

function missingBootFiles(targetRoot: string): string[] {
  return GODOT_MOBILE_SCAFFOLD_FILES.filter(relativePath => !existsSync(join(targetRoot, relativePath)));
}

export function seedGodotMobileScaffold(input: GodotScaffoldSeedInput): GodotScaffoldSeedResult {
  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const targetType = detectRuntimeVerificationTargetType({
    rawTask: input.rawTask,
    projectRoot: input.projectRoot,
    toolCallLog: input.toolCallLog ?? [],
  });

  if (targetType !== 'godot') {
    return {
      stage: 'godot_scaffold_seed',
      targetType,
      targetRoot: input.projectRoot,
      scaffoldTemplate: null,
      filesCopied: [],
      filesSkipped: [],
      status: 'SKIPPED_WITH_REASON',
      reason: 'No known Godot mobile game target was detected.',
      timestamp,
    };
  }

  if (!input.projectRoot) {
    return {
      stage: 'godot_scaffold_seed',
      targetType,
      targetRoot: null,
      scaffoldTemplate: null,
      filesCopied: [],
      filesSkipped: [],
      status: 'SKIPPED_WITH_REASON',
      reason: 'Godot scaffold seeding requires a resolved target project root.',
      timestamp,
    };
  }

  const targetRoot = resolve(input.projectRoot);
  const scaffoldTemplate = resolve(input.scaffoldTemplate ?? defaultGodotMobileScaffoldTemplate(input.babelRoot ?? resolve('..')));
  if (!existsSync(scaffoldTemplate) || !statSync(scaffoldTemplate).isDirectory()) {
    return {
      stage: 'godot_scaffold_seed',
      targetType,
      targetRoot,
      scaffoldTemplate,
      filesCopied: [],
      filesSkipped: [],
      status: 'FAILED',
      reason: `Godot scaffold template is unavailable at ${scaffoldTemplate}.`,
      timestamp,
    };
  }

  mkdirSync(targetRoot, { recursive: true });
  const missing = missingBootFiles(targetRoot);
  if (!isDirectoryEmpty(targetRoot) && missing.length === 0) {
    return {
      stage: 'godot_scaffold_seed',
      targetType,
      targetRoot,
      scaffoldTemplate,
      filesCopied: [],
      filesSkipped: [...GODOT_MOBILE_SCAFFOLD_FILES],
      status: 'NOOP',
      reason: 'Godot boot files already exist; scaffold seeding did not overwrite user files.',
      timestamp,
    };
  }

  const filesCopied: string[] = [];
  const filesSkipped: string[] = [];
  for (const relativePath of GODOT_MOBILE_SCAFFOLD_FILES) {
    const source = join(scaffoldTemplate, relativePath);
    const destination = join(targetRoot, relativePath);
    if (existsSync(destination)) {
      filesSkipped.push(relativePath);
      continue;
    }
    if (!existsSync(source) || !statSync(source).isFile()) {
      filesSkipped.push(relativePath);
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    filesCopied.push(relativePath);
  }

  return {
    stage: 'godot_scaffold_seed',
    targetType,
    targetRoot,
    scaffoldTemplate,
    filesCopied,
    filesSkipped,
    status: filesCopied.length > 0 ? 'SEEDED' : 'NOOP',
    reason: filesCopied.length > 0
      ? 'Missing Godot mobile scaffold files were copied without overwriting existing files.'
      : 'No scaffold files were copied.',
    timestamp,
  };
}
