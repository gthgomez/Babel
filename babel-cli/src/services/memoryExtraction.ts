import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runWithFallback } from '../execute.js';
import { MemoryExtractionSchema } from '../schemas/agentContracts.js';
import type { EvidenceBundle } from '../evidence.js';
import {
  buildUntrustedContentBlock,
  untrustedContentInstruction,
} from '../utils/untrustedContent.js';
import {
  resolveMemoryRoot,
  writeMemory,
} from './memory/memoryStore.js';

/**
 * Extract and save memories from a Babel execution report.
 *
 * Writes directly to the structured memory directory (~/.babel/projects/{slug}/memory/)
 * with frontmatter and auto-updates the MEMORY.md index.
 * Falls back to the legacy `.babel/project_memories.md` path when the structured
 * directory cannot be resolved.
 */
export async function extractAndSaveMemories(
  runDir: string,
  projectRoot: string | undefined,
  evidence?: EvidenceBundle,
): Promise<void> {
  const targetRoot = projectRoot || process.cwd();

  // 1. Gather context for extraction
  const reportPath = join(runDir, '04_execution_report.json');
  if (!existsSync(reportPath)) return;

  const report = readFileSync(reportPath, 'utf-8');

  const extractionPrompt = `
You are the Babel Memory Extractor. Analyze the following execution report and identify critical project-specific knowledge (architectural patterns, fixed bugs, environment quirks) that should be remembered for future sessions.
${untrustedContentInstruction('execution_report')}

EXECUTION REPORT:
${buildUntrustedContentBlock('execution_report', report)}

Follow the Skill: Memory Extraction rules.
`;

  try {
    const result = await runWithFallback(extractionPrompt, MemoryExtractionSchema, {
      stage: 'orchestrator',
      schemaName: 'MemoryExtractionSchema',
      ...(evidence ? { evidence } : {}),
    });

    if (result.memories.length === 0) return;

    // Try structured memory directory first
    const memoryRoot = resolveMemoryRoot(targetRoot);
    if (memoryRoot) {
      let savedCount = 0;
      for (const m of result.memories) {
        const slug = m.topic
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60);

        if (!slug) continue;

        const body = [
          `**Impact:** ${m.impact_severity.toUpperCase()}`,
          '',
          m.memory_content,
          '',
        ].join('\n');

        const ok = writeMemory(memoryRoot, {
          name: slug,
          description: m.topic.slice(0, 120),
          metadata: { type: inferMemoryType(m) },
        }, body);

        if (ok) savedCount++;
      }

      if (savedCount > 0) {
        console.log(`[memory] ✓ Extracted ${savedCount} new memories to ${memoryRoot}`);
      }
      return;
    }

    // Fallback: legacy project_memories.md format
    const memoryDir = join(targetRoot, '.babel');
    const memoryPath = join(memoryDir, 'project_memories.md');

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    let memoryMarkdown = '';
    if (!existsSync(memoryPath)) {
      memoryMarkdown = `# Project Memories\n\nThis file contains long-term intelligence extracted from previous Babel runs.\n\n`;
    }

    result.memories.forEach((m) => {
      const date = new Date().toISOString().split('T')[0];
      memoryMarkdown += `### [${m.topic}] (${date})\n`;
      memoryMarkdown += `**Impact:** ${m.impact_severity.toUpperCase()}\n`;
      memoryMarkdown += `${m.memory_content}\n\n`;
    });

    writeFileSync(memoryPath, memoryMarkdown, { flag: 'a' });
    console.log(`[memory] ✓ Extracted ${result.memories.length} new memories to ${memoryPath}`);
  } catch (error) {
    console.warn(
      `[memory] ✗ Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Infer a memory type from extraction data.
 * Defaults to 'project' for extracted memories (most common type).
 */
function inferMemoryType(m: { topic: string; memory_content: string; impact_severity: string }): 'user' | 'feedback' | 'project' | 'reference' {
  const combined = `${m.topic} ${m.memory_content}`.toLowerCase();

  if (/\b(user|role|preference|persona)\b/.test(combined)) return 'user';
  if (/\b(feedback|guidance|prefer|avoid|dont|should)/.test(combined)) return 'feedback';
  if (/\b(reference|pointer|documentation|located|found in|dashboard|url|api endpoint)\b/.test(combined)) return 'reference';

  return 'project';
}

// ─── Memory management utilities ──────────────────────────────────────────

export interface ProjectMemoryEntry {
  topic: string;
  date: string;
  impact: string;
  content: string;
  staleDays: number;
}

const DEFAULT_STALE_DAYS = 30;

export function readProjectMemories(projectRoot?: string): ProjectMemoryEntry[] {
  const root = projectRoot ?? process.cwd();
  const memoryPath = join(root, '.babel', 'project_memories.md');
  if (!existsSync(memoryPath)) {
    return [];
  }

  const content = readFileSync(memoryPath, 'utf-8');
  const entries: ProjectMemoryEntry[] = [];
  const headerRe = /^### \[(.+?)\] \((\d{4}-\d{2}-\d{2})\)$/;
  const impactRe = /^\*\*Impact:\*\* (.+)$/;
  const staleRe = /^\*\*Staleness:\*\*\s*(\d+)\s*days?$/i;

  let current: Partial<ProjectMemoryEntry> | null = null;
  let contentLines: string[] = [];

  for (const line of content.split('\n')) {
    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      if (current) {
        entries.push({
          topic: current.topic ?? 'unknown',
          date: current.date ?? 'unknown',
          impact: current.impact ?? 'unknown',
          content: contentLines.join('\n').trim(),
          staleDays: current.staleDays ?? DEFAULT_STALE_DAYS,
        });
      }
      current = { topic: headerMatch[1] ?? 'unknown', date: headerMatch[2] ?? 'unknown' };
      contentLines = [];
      continue;
    }

    const impactMatch = line.match(impactRe);
    if (impactMatch && current) {
      current.impact = impactMatch[1] ?? 'unknown';
      continue;
    }

    const staleMatch = line.match(staleRe);
    if (staleMatch && current) {
      current.staleDays = parseInt(staleMatch[1] ?? String(DEFAULT_STALE_DAYS), 10);
      continue;
    }

    if (current && line.trim()) {
      contentLines.push(line);
    }
  }

  // Last entry
  if (current) {
    entries.push({
      topic: current.topic ?? 'unknown',
      date: current.date ?? 'unknown',
      impact: current.impact ?? 'unknown',
      content: contentLines.join('\n').trim(),
      staleDays: current.staleDays ?? DEFAULT_STALE_DAYS,
    });
  }

  return entries;
}

export function pruneStaleMemories(
  projectRoot?: string,
  maxAgeDays: number = DEFAULT_STALE_DAYS,
): number {
  const root = projectRoot ?? process.cwd();
  const entries = readProjectMemories(root);
  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000);
  const cutoffStr = cutoff.toISOString().split('T')[0] ?? '';

  const fresh = entries.filter((entry) => entry.date >= cutoffStr);
  const pruned = entries.length - fresh.length;

  if (pruned === 0) {
    return 0;
  }

  // Rewrite the file with only fresh entries
  const memoryPath = join(root, '.babel', 'project_memories.md');
  let output = '# Project Memories\n\n';
  output += 'This file contains long-term intelligence extracted from previous Babel runs.\n';
  output += `Pruned ${pruned} stale entries (older than ${maxAgeDays} days) on ${now.toISOString().split('T')[0]}.\n\n`;

  for (const entry of fresh) {
    output += `### [${entry.topic}] (${entry.date})\n`;
    output += `**Impact:** ${entry.impact}\n`;
    output += `${entry.content}\n\n`;
  }

  writeFileSync(memoryPath, output, 'utf-8');
  return pruned;
}

export function queryMemories(projectRoot: string | undefined, term: string): ProjectMemoryEntry[] {
  const entries = readProjectMemories(projectRoot);
  const lower = term.toLowerCase();
  return entries.filter(
    (entry) =>
      entry.topic.toLowerCase().includes(lower) ||
      entry.content.toLowerCase().includes(lower) ||
      entry.impact.toLowerCase().includes(lower),
  );
}

export function writeDailyLog(projectRoot: string | undefined, summary: string): void {
  const root = projectRoot ?? process.cwd();
  const today = new Date().toISOString().split('T')[0] ?? 'unknown-date';
  const timestamp = new Date().toISOString();
  const entry = `- **${timestamp}** — ${summary}\n`;

  // Gap-2: prefer structured memory logs at
  // ~/.babel/projects/{slug}/memory/logs/YYYY/MM/YYYY-MM-DD.md
  const memoryRoot = resolveMemoryRoot(root);
  if (memoryRoot) {
    const [year, month] = today.split('-');
    if (year && month) {
      const dailyDir = join(memoryRoot, 'logs', year, month);
      if (!existsSync(dailyDir)) {
        mkdirSync(dailyDir, { recursive: true });
      }
      writeFileSync(join(dailyDir, `${today}.md`), entry, { flag: 'a' });
      return;
    }
  }

  // Fallback: legacy project-local path
  const dailyDir = join(root, '.babel', 'daily');
  if (!existsSync(dailyDir)) {
    mkdirSync(dailyDir, { recursive: true });
  }
  writeFileSync(join(dailyDir, `${today}.md`), entry, { flag: 'a' });
}
