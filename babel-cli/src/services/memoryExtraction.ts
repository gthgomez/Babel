import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithFallback } from '../execute.js';
import { MemoryExtractionSchema } from '../schemas/agentContracts.js';
import { EvidenceBundle } from '../evidence.js';
import {
  buildUntrustedContentBlock,
  untrustedContentInstruction,
} from '../utils/untrustedContent.js';

export async function extractAndSaveMemories(
  runDir: string,
  projectRoot: string | undefined,
  evidence?: EvidenceBundle
): Promise<void> {
  const targetRoot = projectRoot || process.cwd();
  const memoryDir = join(targetRoot, '.babel');
  const memoryPath = join(memoryDir, 'project_memories.md');

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
      ...(evidence ? { evidence } : {})
    });

    if (result.memories.length === 0) return;

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    let memoryMarkdown = '';
    if (!existsSync(memoryPath)) {
      memoryMarkdown = `# Project Memories\n\nThis file contains long-term intelligence extracted from previous Babel runs.\n\n`;
    }

    result.memories.forEach(m => {
      const date = new Date().toISOString().split('T')[0];
      memoryMarkdown += `### [${m.topic}] (${date})\n`;
      memoryMarkdown += `**Impact:** ${m.impact_severity.toUpperCase()}\n`;
      memoryMarkdown += `${m.memory_content}\n\n`;
    });

    appendFileSync(memoryPath, memoryMarkdown);
    console.log(`[memory] ✓ Extracted ${result.memories.length} new memories to ${memoryPath}`);

  } catch (error) {
    console.warn(`[memory] ✗ Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
