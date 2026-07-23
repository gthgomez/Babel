// ─── Permissions / Settings Command Handlers ─────────────────────────────────
// Extracted from interactive.ts — approval profiles and project settings.

import type { ReplContext } from '../context.js';
import { VALID_MODES, type ValidMode } from '../../cli/constants.js';
import {
  APPROVAL_PROFILE_DEFINITIONS,
  APPROVAL_PROFILES,
  parseApprovalProfile,
  readApprovalProfileStatus,
  writeApprovalProfile,
} from '../../config/approvalProfiles.js';
import {
  readProjectSettings,
  writeProjectSettings,
  type ProjectSettings,
} from '../../config/projectSettings.js';
import { renderErrorPanel } from '../../ui/renderers.js';
import { accentBright, error, muted, primary, padRight } from '../../ui/theme.js';

export function handlePermissions(_ctx: ReplContext, args: string[]): void {
  const requested = args[0]?.toLowerCase();
  if (!requested) {
    const status = readApprovalProfileStatus();
    console.log(primary('\n  Approval Profile:'));
    console.log(`    ${muted(padRight('Profile', 14))} ${accentBright(status.profile)}`);
    console.log(`    ${muted(padRight('Runtime', 14))} ${status.runtimeMode}`);
    console.log(
      `    ${muted(padRight('Dry run', 14))} ${status.dryRun.effective ? accentBright('on') : muted('off')}`,
    );
    console.log(muted('\n  Available profiles:'));
    APPROVAL_PROFILES.forEach((profile) => {
      console.log(
        `    - ${accentBright(padRight(profile, 10))} ${muted(APPROVAL_PROFILE_DEFINITIONS[profile].description)}`,
      );
    });
    return;
  }

  const profile = parseApprovalProfile(requested);
  if (!profile) {
    console.log(
      accentBright(`\n  Invalid profile: "${requested}". Use ${APPROVAL_PROFILES.join(', ')}.`),
    );
    return;
  }

  const status = writeApprovalProfile(profile);
  console.log(primary(`\n  Approval profile set to ${accentBright(status.profile)}`));
  console.log(
    muted(`  Runtime: ${status.runtimeMode}; dry-run: ${status.dryRun.effective ? 'on' : 'off'}`),
  );
}

export function handleSettings(ctx: ReplContext, args: string[]): void {
  const target = ctx.resolveCurrentTarget();
  if (!target.targetRoot) {
    console.log(muted('\n  No project detected. Settings require a project root.'));
    return;
  }

  if (args.length === 0) {
    // Display current settings
    const settings = readProjectSettings(target.targetRoot);
    if (Object.keys(settings).length === 0) {
      console.log(muted('\n  No project settings found.'));
      console.log(muted('  Use /settings <key> <value> to configure.'));
      console.log(muted('  Keys: model, mode, approvalProfile'));
    } else {
      console.log(primary('\n  Project Settings:'));
      if (settings.model) console.log(`    ${muted('model')}  ${accentBright(settings.model)}`);
      if (settings.mode) console.log(`    ${muted('mode')}   ${accentBright(settings.mode)}`);
      if (settings.approvalProfile)
        console.log(`    ${muted('profile')} ${accentBright(settings.approvalProfile)}`);
    }
    return;
  }

  // Set a setting: /settings <key> <value>
  const key = args[0]?.toLowerCase();
  const value = args.slice(1).join(' ');

  if (!key || !value) {
    console.log(accentBright('\n  Usage: /settings <key> <value>'));
    console.log(muted('  Keys: model, mode, approvalProfile'));
    return;
  }

  const current = readProjectSettings(target.targetRoot);
  const update: ProjectSettings = { ...current };

  switch (key) {
    case 'model':
      update.model = value;
      break;
    case 'mode':
      if (['chat', 'plan', 'deep'].includes(value)) {
        update.mode = value as ValidMode;
      } else {
        console.log(accentBright(`\n  Invalid mode: "${value}". Use chat, plan, or deep.`));
        return;
      }
      break;
    case 'approvalprofile':
      update.approvalProfile = value;
      break;
    default:
      console.log(
        accentBright(`\n  Unknown setting: "${key}". Use model, mode, or approvalProfile.`),
      );
      return;
  }

  const result = writeProjectSettings(target.targetRoot, update);
  if (result.ok) {
    console.log(primary(`\n  Project setting "${key}" set to "${value}".`));
    // Apply immediately if model
    if (key === 'model') {
      ctx.state.model = value;
      ctx.resolveSessionModel();
      ctx.saveSessionState();
    }
    if (key === 'mode') {
      ctx.state.mode = value as ValidMode;
      ctx.saveSessionState();
      console.log(primary(`  Mode is now ${accentBright(value)}.`));
    }
  } else {
    console.log(error(`\n  Failed to save settings: ${result.error ?? 'unknown error'}`));
  }
}
