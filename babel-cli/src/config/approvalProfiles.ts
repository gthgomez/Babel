import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import {
  readDryRunState,
  type DryRunState,
  writeDryRunState,
} from '../cli/helpers.js';
import { readRuntimeMode, writeRuntimeMode } from './runtimeMode.js';
import type { ExecutorMode } from '../sandbox.js';

export const APPROVAL_PROFILES = ['suggest', 'auto-edit', 'full-auto'] as const;
export type ApprovalProfile = typeof APPROVAL_PROFILES[number];

export interface ApprovalProfileDefinition {
  profile: ApprovalProfile;
  runtimeMode: ExecutorMode;
  dryRun: boolean;
  description: string;
}

export interface ApprovalProfileFile {
  schemaVersion?: number;
  profile?: string;
  updatedAt?: string;
}

export interface ApprovalProfileStatus {
  profile: ApprovalProfile | 'custom';
  runtimeMode: ExecutorMode;
  dryRun: DryRunState;
  profilePath: string;
}

export const APPROVAL_PROFILE_DEFINITIONS: Record<ApprovalProfile, ApprovalProfileDefinition> = {
  suggest: {
    profile: 'suggest',
    runtimeMode: 'plan',
    dryRun: true,
    description: 'Planning-first mode: mutating tools stay dry-run and executor writes are blocked.',
  },
  'auto-edit': {
    profile: 'auto-edit',
    runtimeMode: 'act',
    dryRun: false,
    description: 'Default coding mode: live edits are allowed through Babel sandbox protections.',
  },
  'full-auto': {
    profile: 'full-auto',
    runtimeMode: 'act',
    dryRun: false,
    description: 'Highest autonomy profile: live edits are allowed; sandbox and policy gates still apply.',
  },
};

function getApprovalProfilePath(): string {
  return join(BABEL_ROOT, 'config', 'approval-profile.json');
}

function normalizeApprovalProfile(value: string | undefined): ApprovalProfile | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return APPROVAL_PROFILES.includes(normalized as ApprovalProfile)
    ? normalized as ApprovalProfile
    : null;
}

function inferApprovalProfile(): ApprovalProfile | 'custom' {
  const runtimeMode = readRuntimeMode();
  const dryRun = readDryRunState();

  if (runtimeMode === 'plan' && dryRun.effective) {
    return 'suggest';
  }

  if (runtimeMode === 'act' && !dryRun.effective) {
    return 'auto-edit';
  }

  return 'custom';
}

export function parseApprovalProfile(value: string): ApprovalProfile | null {
  return normalizeApprovalProfile(value);
}

export function readApprovalProfile(): ApprovalProfile | 'custom' {
  const profilePath = getApprovalProfilePath();
  if (!existsSync(profilePath)) {
    return inferApprovalProfile();
  }

  try {
    const parsed = JSON.parse(readFileSync(profilePath, 'utf-8')) as ApprovalProfileFile;
    const persisted = normalizeApprovalProfile(parsed.profile);
    if (!persisted) {
      return inferApprovalProfile();
    }
    const definition = APPROVAL_PROFILE_DEFINITIONS[persisted];
    const runtimeMode = readRuntimeMode();
    const dryRun = readDryRunState();
    if (runtimeMode === definition.runtimeMode && dryRun.effective === definition.dryRun) {
      return persisted;
    }
    return inferApprovalProfile();
  } catch {
    return inferApprovalProfile();
  }
}

export function writeApprovalProfile(profile: ApprovalProfile): ApprovalProfileStatus {
  const profilePath = getApprovalProfilePath();
  const definition = APPROVAL_PROFILE_DEFINITIONS[profile];
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(
    profilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      profile,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf-8',
  );
  writeRuntimeMode(definition.runtimeMode);
  writeDryRunState(definition.dryRun);
  return readApprovalProfileStatus();
}

export function readApprovalProfileStatus(): ApprovalProfileStatus {
  return {
    profile: readApprovalProfile(),
    runtimeMode: readRuntimeMode(),
    dryRun: readDryRunState(),
    profilePath: getApprovalProfilePath(),
  };
}
