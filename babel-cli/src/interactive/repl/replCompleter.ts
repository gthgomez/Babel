import * as fs from 'node:fs';
import * as path from 'node:path';

import { APPROVAL_PROFILES } from '../../config/approvalProfiles.js';
import { getAvailableModels } from '../../modelPolicy.js';
import { loadPluginRegistry } from '../../services/plugins.js';
import { fuzzyScore } from '../../utils/fuzzy.js';
import { VALID_MODES } from '../../cli/constants.js';
import {
  INTERACTIVE_COMMAND_COMPLETIONS,
  MODE_DESCRIPTIONS,
} from '../types.js';
import type { ReplContext } from '../context.js';

export function fuzzyScoreFilter(sub: string, candidates: string[]): string[] {
  if (!sub) return candidates;
  try {
    const scored = candidates
      .map((c) => ({ candidate: c, score: fuzzyScore(sub, c) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((s) => s.candidate);
  } catch {
    return candidates.filter((c) => c.startsWith(sub));
  }
}

export function buildReplCompleter(ctx: ReplContext) {
  return (line: string): [string[], string] => {
    if (line.startsWith('/mode ')) {
      const sub = line.slice(6);
      const modes = [...Object.keys(MODE_DESCRIPTIONS), ...VALID_MODES];
      const hits = fuzzyScoreFilter(sub, modes);
      return [hits.map((h) => `/mode ${h}`), line];
    }

    if (line.startsWith('/permissions ')) {
      const sub = line.slice(13);
      const hits = fuzzyScoreFilter(sub, [...APPROVAL_PROFILES]);
      return [hits.map((h) => `/permissions ${h}`), line];
    }

    if (line.startsWith('/model ')) {
      const sub = line.slice(7);
      const models = getAvailableModels().map((m) => m.key);
      const hits = fuzzyScoreFilter(sub, models);
      return [hits.map((h) => `/model ${h}`), line];
    }

    if (line.startsWith('/mcp ')) {
      const sub = line.slice(5);
      const mcpSubs = ['doctor', 'tools', 'resources', 'resource', 'prompts', 'prompt'];
      const hits = fuzzyScoreFilter(sub, mcpSubs);
      return [hits.map((h) => `/mcp ${h}`), line];
    }

    if (line.startsWith('/checkpoint ')) {
      const sub = line.slice(12);
      const checkpointSubs = ['list', 'inspect', 'restore'];
      const hits = fuzzyScoreFilter(sub, checkpointSubs);
      return [hits.map((h) => `/checkpoint ${h}`), line];
    }

    if (line.startsWith('/agents ')) {
      const sub = line.slice(8);
      const agentSubs = ['list', 'run', 'inspect', 'merge'];
      const hits = fuzzyScoreFilter(sub, agentSubs);
      return [hits.map((h) => `/agents ${h}`), line];
    }

    if (line.startsWith('/plugins ')) {
      const sub = line.slice(9);
      const registry = loadPluginRegistry();
      const pluginIds = Object.keys(registry);
      const pluginSubs = ['doctor', ...pluginIds];
      const hits = fuzzyScoreFilter(sub, pluginSubs);
      return [hits.map((h) => `/plugins ${h}`), line];
    }

    if (line.startsWith('/git ')) {
      const sub = line.slice(5);
      const hits = fuzzyScoreFilter(sub, ['status', 'diff', 'log']);
      return [hits.map((h) => `/git ${h}`), line];
    }

    if (line.startsWith('/')) {
      const hits = fuzzyScoreFilter(line, [...INTERACTIVE_COMMAND_COMPLETIONS]);
      return [hits, line];
    }

    const lastSpaceIdx = line.lastIndexOf(' ');
    const prefixBefore = lastSpaceIdx === -1 ? '' : line.slice(0, lastSpaceIdx + 1);
    const lastToken = lastSpaceIdx === -1 ? line : line.slice(lastSpaceIdx + 1);

    if (!line.startsWith('/') || line.includes('/') || line.includes('\\') || line.includes('.')) {
      try {
        let dirPortion = '.';
        let filePrefix = lastToken;
        let sepChar = '/';

        const lastSepIdx = Math.max(lastToken.lastIndexOf('/'), lastToken.lastIndexOf('\\'));
        if (lastSepIdx !== -1) {
          dirPortion = lastToken.slice(0, lastSepIdx) || '/';
          filePrefix = lastToken.slice(lastSepIdx + 1);
          sepChar = lastToken.charAt(lastSepIdx);
        }

        const currentTarget = ctx.resolveCurrentTarget();
        const baseDir = currentTarget.targetRoot || process.cwd();
        const absDir = path.resolve(baseDir, dirPortion);

        if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
          const entries = fs.readdirSync(absDir);
          const ignored = new Set(['.git', 'node_modules', '.babel']);

          const matches = entries
            .filter((e) => !ignored.has(e) && e.toLowerCase().startsWith(filePrefix.toLowerCase()))
            .map((e) => {
              const isDir = fs.statSync(path.join(absDir, e)).isDirectory();
              const completedToken =
                lastSepIdx !== -1
                  ? `${dirPortion}${sepChar}${e}${isDir ? sepChar : ''}`
                  : `${e}${isDir ? sepChar : ''}`;
              return prefixBefore + completedToken;
            });

          if (matches.length > 0) {
            return [matches, line];
          }
        }
      } catch {
        /* filesystem optional */
      }
    }

    return [[], line];
  };
}