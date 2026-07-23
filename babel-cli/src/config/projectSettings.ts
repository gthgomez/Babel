import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ValidMode } from '../cli/constants.js';
import { VALID_MODES } from '../cli/constants.js';

export interface ProjectSettings {
  /** Default model key for this project */
  model?: string;
  /** Default mode for this project */
  mode?: ValidMode;
  /** Default approval profile */
  approvalProfile?: string;
}

/**
 * Resolve the .babel/settings.json path for a given project root.
 * Returns null if no project root is provided.
 */
export function getProjectSettingsPath(projectRoot?: string): string | null {
  if (!projectRoot) return null;
  return path.join(projectRoot, '.babel', 'settings.json');
}

/**
 * Read and parse project settings. Returns empty object if file is
 * missing, unreadable, or contains invalid data.
 */
export function readProjectSettings(projectRoot: string): ProjectSettings {
  try {
    const settingsPath = getProjectSettingsPath(projectRoot);
    if (!settingsPath || !fs.existsSync(settingsPath)) return {};

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) return {};

    const settings: ProjectSettings = {};

    if (typeof parsed.model === 'string' && parsed.model.length > 0) {
      settings.model = parsed.model;
    }

    if (typeof parsed.mode === 'string' && VALID_MODES.includes(parsed.mode as ValidMode)) {
      settings.mode = parsed.mode as ValidMode;
    }

    if (typeof parsed.approvalProfile === 'string' && parsed.approvalProfile.length > 0) {
      settings.approvalProfile = parsed.approvalProfile;
    }

    return settings;
  } catch {
    return {};
  }
}

/**
 * Write project settings to .babel/settings.json.
 * Creates the .babel directory if it doesn't exist.
 */
export function writeProjectSettings(
  projectRoot: string,
  settings: ProjectSettings,
): { ok: boolean; error?: string } {
  try {
    const settingsPath = getProjectSettingsPath(projectRoot);
    if (!settingsPath) {
      return { ok: false, error: 'No project root available' };
    }

    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Merge project settings into existing session state.
 * Project settings provide defaults only — they do NOT override
 * explicit session-level choices (e.g., /model already called).
 */
export function mergeProjectSettings(
  current: { model?: string; mode?: ValidMode; resolvedModelId?: string; approvalProfile?: string },
  projectSettings: ProjectSettings,
  projectSettingsAlreadyApplied: boolean,
): {
  model?: string;
  mode?: ValidMode;
  resolvedModelId?: string;
  approvalProfile?: string;
  applied: boolean;
} {
  // Only apply once per session to avoid overriding user changes
  if (projectSettingsAlreadyApplied) {
    return { ...current, applied: false };
  }

  const result = { ...current, applied: true };

  // Project mode is a default — only set if user hasn't explicitly chosen a mode
  if (projectSettings.mode && !current.mode) {
    result.mode = projectSettings.mode;
  }

  // Project model is a default — only set if user hasn't explicitly chosen a model
  if (projectSettings.model && !current.model) {
    result.model = projectSettings.model;
  }

  // Project approvalProfile is a default — only set if not already chosen
  if (projectSettings.approvalProfile && !current.approvalProfile) {
    result.approvalProfile = projectSettings.approvalProfile;
  }

  return result;
}
