import { readFileSync } from 'node:fs';

export type CatalogLayer =
  | 'behavioral_os'
  | 'domain_architect'
  | 'skill'
  | 'model_adapter'
  | 'project_overlay'
  | 'task_overlay'
  | 'pipeline_stage'
  | 'entrypoint'
  | 'orchestrator'
  | 'config'
  | 'meta_tool';

export interface CatalogEntry {
  id: string;
  layer: CatalogLayer | string;
  path: string | null;
  loadPosition: number | null;
  status: string | null;
  tokenBudget: number | null;
  orderIndex: number;
  dependencies: string[];
  conflicts: string[];
  defaultSkillIds: string[];
  tags: string[];
  project: string | null;
}

export interface CatalogInspectionFilters {
  ids?: string[];
  layer?: string;
  project?: string;
  status?: string;
  tags?: string[];
}

export function parseInlineArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return null;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return inner
    .split(',')
    .map(item => item.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

export function parseCatalog(catalogPath: string): CatalogEntry[] {
  const lines = readFileSync(catalogPath, 'utf-8').split(/\r?\n/);
  const entries: CatalogEntry[] = [];
  let current: CatalogEntry | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';

    const idMatch = /^\s*-\s+id:\s+(.+)$/.exec(line);
    if (idMatch) {
      if (current) {
        entries.push(current);
      }

      current = {
        id: idMatch[1]!.trim(),
        layer: '',
        path: null,
        loadPosition: null,
        status: null,
        tokenBudget: null,
        orderIndex: entries.length,
        dependencies: [],
        conflicts: [],
        defaultSkillIds: [],
        tags: [],
        project: null,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const scalarParsers: Array<{
      regex: RegExp;
      apply: (value: string) => void;
    }> = [
      { regex: /^\s+layer:\s+(.+)$/, apply: value => { current!.layer = value.trim(); } },
      { regex: /^\s+path:\s+(.+)$/, apply: value => { current!.path = value.trim().replace(/^"|"$/g, ''); } },
      { regex: /^\s+status:\s+(.+)$/, apply: value => { current!.status = value.trim(); } },
      { regex: /^\s+load_position:\s+(.+)$/, apply: value => { current!.loadPosition = Number.parseInt(value.trim(), 10); } },
      { regex: /^\s+project:\s+(.+)$/, apply: value => { current!.project = value.trim().replace(/^"|"$/g, ''); } },
      {
        regex: /^\s+token_budget:\s+(.+)$/,
        apply: value => {
          const parsedBudget = Number.parseInt(value.trim(), 10);
          current!.tokenBudget = Number.isFinite(parsedBudget) ? parsedBudget : null;
        },
      },
    ];

    let matchedScalar = false;
    for (const parser of scalarParsers) {
      const match = parser.regex.exec(line);
      if (match) {
        parser.apply(match[1]!);
        matchedScalar = true;
        break;
      }
    }
    if (matchedScalar) {
      continue;
    }

    const listMatch = /^\s+(dependencies|conflicts|default_skill_ids|tags):\s*(.*)$/.exec(line);
    if (!listMatch) {
      continue;
    }

    const key = listMatch[1]!;
    const rawValue = listMatch[2] ?? '';
    const inlineArray = parseInlineArray(rawValue);
    const values = inlineArray ?? [];

    if (inlineArray === null) {
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1] ?? '';
        const itemMatch = /^\s{6,}-\s+(.+)$/.exec(nextLine);
        if (!itemMatch) {
          break;
        }
        values.push(itemMatch[1]!.trim());
        index++;
      }
    }

    if (key === 'dependencies') {
      current.dependencies = values;
    } else if (key === 'conflicts') {
      current.conflicts = values;
    } else if (key === 'default_skill_ids') {
      current.defaultSkillIds = values;
    } else if (key === 'tags') {
      current.tags = values;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

export function filterCatalogEntries(
  entries: CatalogEntry[],
  filters: CatalogInspectionFilters = {},
): CatalogEntry[] {
  return entries.filter(entry => {
    if (filters.ids && filters.ids.length > 0 && !filters.ids.includes(entry.id)) {
      return false;
    }
    if (filters.layer && entry.layer !== filters.layer) {
      return false;
    }
    if (filters.project && entry.project !== filters.project) {
      return false;
    }
    if (filters.status && entry.status !== filters.status) {
      return false;
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        if (!entry.tags.includes(tag)) {
          return false;
        }
      }
    }
    return true;
  });
}
