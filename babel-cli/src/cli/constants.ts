import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_POLICY_TIERS } from '../modelPolicy.js';

export const VALID_MODES = ['direct', 'verified', 'autonomous', 'manual', 'parallel_swarm'] as const;
export type ValidMode = typeof VALID_MODES[number];

export const VALID_MODEL_TIERS = [...MODEL_POLICY_TIERS] as const;

export const VALID_PROJECTS = [
  'example_saas_backend',
  'example_llm_router',
  'example_web_audit',
  'example_mobile_suite',
  'example_reference_application',
  'example_simulation',
  'example_game_suite',
  'example_game_workspace',
  'example_game_draft',
  'example_autonomous_agent',
  'example_mobile_reference',
] as const;
export type ValidProject = typeof VALID_PROJECTS[number];

export const VALID_ORCHESTRATORS = ['v9'] as const;
export type ValidOrchestrator = typeof VALID_ORCHESTRATORS[number];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findBabelRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'prompt_catalog.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir, '../../..');
    }
    current = parent;
  }
}

export const BABEL_ROOT = process.env['BABEL_ROOT'] ?? findBabelRoot(__dirname);
export const BABEL_RUNS_DIR = process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');
