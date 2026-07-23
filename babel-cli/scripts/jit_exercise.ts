#!/usr/bin/env tsx
/**
 * jit_exercise.ts — JIT Exercise Harness
 *
 * Live streaming exercise that sends a task prompt to the DeepSeek API,
 * pipes each SSE delta through IncrementalToolDetector, auto-approves
 * read-only tool intents, auto-denies mutating ones, and writes evidence
 * artifacts to evidence/jit-exercise-<timestamp>/.
 *
 * Usage: tsx --no-warnings=ExperimentalWarning scripts/jit_exercise.ts
 * Env:   DEEPSEEK_API_KEY  (required for live execution)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IncrementalToolDetector,
  computeFingerprint,
  JitDenialError,
} from '../src/ui/incrementalToolDetector.js';
import type { PartialToolIntent } from '../src/ui/incrementalToolDetector.js';
import { DeepSeekApiRunner } from '../src/runners/deepSeekApi.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

const READ_ONLY_TOOLS = new Set([
  'file_read',
  'directory_list',
  'grep',
  'glob',
  'semantic_search',
]);

function isReadOnlyTool(tool: string): boolean {
  return READ_ONLY_TOOLS.has(tool);
}

/**
 * Task prompt designed to trigger tool intents.  The model is asked to read a
 * file and check for issues — a natural scenario that invites file_read, grep,
 * and glob calls.  Mutating tools (file_write, shell_exec, test_run) are
 * listed as available so the exercise can also exercise the veto path.
 */
const TASK_PROMPT = `You are an AI assistant with tool access. Please perform the following task:

Read the file src/index.js and tell me what it does, then check if there are any issues.

When you need to use a tool, format your call like this:
<|tool_start|>{"type":"tool_call","tool":"file_read","path":"src/index.js"}<|tool_end|>

Available tools:
  Read-only:
    - file_read(path)         — Read file contents
    - directory_list(path)    — List directory entries
    - grep(pattern, path)     — Search for a pattern in files
    - glob(pattern)           — Find files by glob pattern
    - semantic_search(query)  — Semantic code search

  Mutating (for demonstration only — do not actually use):
    - file_write(path, content)
    - shell_exec(command)
    - test_run(suite)

Show your tool calls inline with the <|tool_start|> marker format.`;

// ── Types ──────────────────────────────────────────────────────────────────────

interface DetectorEvent {
  tool: string;
  target: string;
  fingerprint: string;
  action: 'approve' | 'deny';
}

interface Telemetry {
  chunksReceived: number;
  detectorFires: number;
  vetoes: number;
  jitLatencyMs: number;
  peakBufferBytes: number;
  streamingDurationMs: number;
  model: string;
  errorType: string | null;
  errorMessage: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timestampDir(): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const d = new Date();
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `jit-exercise-${y}${mo}${day}-${h}${mi}${s}`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Check API key before anything else (graceful skip path)
  const apiKey = process.env['DEEPSEEK_API_KEY'];
  if (!apiKey) {
    console.log();
    console.log('  DEEPSEEK_API_KEY not set — skipping live exercise');
    console.log('  Set DEEPSEEK_API_KEY in your environment to run the JIT exercise');
    console.log('  against the live DeepSeek API.');
    console.log();
    process.exit(0);
  }

  // 2. Instantiate runner (validates key + model)
  console.log();
  console.log('  [JIT EXERCISE] Creating DeepSeekApiRunner...');
  const runner = new DeepSeekApiRunner(MODEL);

  // 3. State
  const events: DetectorEvent[] = [];
  const deniedFingerprints: string[] = [];
  let detectorFires = 0;
  let vetoes = 0;
  let chunksReceived = 0;
  let caughtJitError: JitDenialError | null = null;

  // 4. Create detector
  const detector = new IncrementalToolDetector(
    async (intent: PartialToolIntent): Promise<'approve' | 'deny'> => {
      detectorFires++;
      const fp = computeFingerprint(intent.tool, intent.target, intent.args);

      if (isReadOnlyTool(intent.tool)) {
        console.log(`  [JIT APPROVE] ${intent.tool} on "${intent.target}"  fp=${fp.slice(0, 16)}...`);
        events.push({ tool: intent.tool, target: intent.target, fingerprint: fp, action: 'approve' });
        return 'approve';
      }

      vetoes++;
      deniedFingerprints.push(fp);
      console.log(`  [JIT DENY]    ${intent.tool} on "${intent.target}"  fp=${fp.slice(0, 16)}...  (mutating — auto-denied)`);
      events.push({ tool: intent.tool, target: intent.target, fingerprint: fp, action: 'deny' });
      return 'deny';
    },
  );

  // 5. Stream chat completion via direct API call (no response_format constraint so
  //    the model can emit raw <|tool_start|> markers the detector can find)
  console.log('  [JIT EXERCISE] Streaming completion...');

  const startedAt = Date.now();
  let fullContent = '';

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful AI assistant with tool access. ' +
              'Demonstrate your tool use capabilities by outputting tool calls ' +
              'inline using <|tool_start|> markers.',
          },
          { role: 'user', content: TASK_PROMPT },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunksReceived++;
      const raw = decoder.decode(value, { stream: true });
      buffer += raw;

      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
            }>;
          };

          const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
          const delta = json.choices?.[0]?.delta?.content || '';

          // Feed reasoning content first, then visible content
          if (reasoning) {
            fullContent += reasoning;
            await detector.feed(reasoning);
          }
          if (delta) {
            fullContent += delta;
            await detector.feed(delta);
          }
        } catch (parseErr) {
          // Propagate JIT denial errors; ignore transient parse failures
          if (parseErr instanceof JitDenialError) {
            reader.cancel().catch(() => {});
            caughtJitError = parseErr;
            break;
          }
        }
      }

      // Break outer loop if a JIT error was caught
      if (caughtJitError) break;
    }

    // Flush any remaining data in the buffer
    if (!caughtJitError && buffer.startsWith('data: ')) {
      const payload = buffer.slice(6).trim();
      if (payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string };
            }>;
          };
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullContent += delta;
            await detector.feed(delta);
          }
        } catch {
          // Ignore partial / incomplete final line
        }
      }
    }
  } catch (err) {
    if (err instanceof JitDenialError) {
      caughtJitError = err;
    } else {
      // Unexpected error — rethrow
      throw err;
    }
  }

  const elapsed = Date.now() - startedAt;

  // 6. Write evidence
  const dirName = timestampDir();
  const evidenceDir = join(process.cwd(), 'evidence', dirName);
  mkdirSync(evidenceDir, { recursive: true });

  // detector_events.json
  writeFileSync(
    join(evidenceDir, 'detector_events.json'),
    JSON.stringify(events, null, 2),
    'utf-8',
  );

  // session_state.json
  writeFileSync(
    join(evidenceDir, 'session_state.json'),
    JSON.stringify(
      { deniedFingerprints },
      null,
      2,
    ),
    'utf-8',
  );

  // telemetry.json
  const telemetry: Telemetry = {
    chunksReceived,
    detectorFires,
    vetoes,
    jitLatencyMs: detector.jitLatencyMs,
    peakBufferBytes: detector.peakBufferBytes,
    streamingDurationMs: elapsed,
    model: MODEL,
    errorType: caughtJitError ? 'JitDenialError' : null,
    errorMessage: caughtJitError ? caughtJitError.message : null,
  };
  writeFileSync(
    join(evidenceDir, 'telemetry.json'),
    JSON.stringify(telemetry, null, 2),
    'utf-8',
  );

  // summary.md
  const summaryLines: string[] = [
    `# JIT Exercise Summary`,
    ``,
    `**Timestamp:** ${new Date().toISOString()}`,
    `**Model:** ${MODEL}`,
    `**Streaming Duration:** ${elapsed} ms`,
    ``,
    `## Detector Activity`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Chunks Received | ${chunksReceived} |`,
    `| Detector Fires  | ${detectorFires} |`,
    `| Vetoes          | ${vetoes} |`,
    `| JIT Latency     | ${detector.jitLatencyMs} ms |`,
    `| Peak Buffer     | ${detector.peakBufferBytes} bytes |`,
    ``,
    `## Tool Intents`,
    ``,
  ];

  if (events.length === 0) {
    summaryLines.push(`No tool intents were detected during the streaming session.`);
  } else {
    summaryLines.push(`| # | Tool | Target | Action | Fingerprint |`);
    summaryLines.push(`|---|------|--------|--------|-------------|`);
    for (let idx = 0; idx < events.length; idx++) {
      const ev = events[idx];
      summaryLines.push(
        `| ${idx + 1} | ${ev.tool} | ${ev.target} | ${ev.action} | \`${ev.fingerprint.slice(0, 16)}...\` |`,
      );
    }
  }

  if (caughtJitError) {
    summaryLines.push(``);
    summaryLines.push(`## JIT Denial Error`);
    summaryLines.push(``);
    summaryLines.push(`A tool intent was denied during streaming:`);
    summaryLines.push(`- **Tool:** ${caughtJitError.tool}`);
    summaryLines.push(`- **Target:** ${caughtJitError.target}`);
    summaryLines.push(`- **Message:** ${caughtJitError.message}`);
    summaryLines.push(``);
    summaryLines.push(`The stream was cancelled after the denial.`);
  }

  summaryLines.push(``);
  summaryLines.push(`## Evidence Artifacts`);
  summaryLines.push(``);
  summaryLines.push(`- \`detector_events.json\` — ${events.length} event(s)`);
  summaryLines.push(`- \`session_state.json\` — ${deniedFingerprints.length} denied fingerprint(s)`);
  summaryLines.push(`- \`telemetry.json\` — exercise telemetry`);

  writeFileSync(
    join(evidenceDir, 'summary.md'),
    summaryLines.join('\n'),
    'utf-8',
  );

  // 7. Print clean summary to stdout
  console.log();
  console.log('  ── JIT Exercise Complete ──');
  console.log(`  Evidence:        evidence/${dirName}/`);
  console.log(`  Duration:        ${elapsed} ms`);
  console.log(`  Chunks:          ${chunksReceived}`);
  console.log(`  Detector Fires:  ${detectorFires}`);
  console.log(`  Vetoes:          ${vetoes}`);
  console.log(`  JIT Latency:     ${detector.jitLatencyMs} ms`);
  console.log(`  Peak Buffer:     ${detector.peakBufferBytes} bytes`);

  if (caughtJitError) {
    console.log(`  JIT Error:       ${caughtJitError.tool} on "${caughtJitError.target}" (denied)`);
  }

  if (events.length > 0) {
    console.log();
    console.log('  Tool Intents:');
    for (const ev of events) {
      const symbol = ev.action === 'approve' ? 'ALLOW' : 'DENY';
      console.log(`    [${symbol}] ${ev.tool} -> ${ev.target}`);
    }
  }

  console.log();
  console.log(`  Evidence written to: ${evidenceDir}`);
  console.log();
}

main().catch((err: unknown) => {
  console.error();
  console.error('  [JIT EXERCISE FATAL]', err instanceof Error ? err.message : String(err));
  console.error();
  process.exit(1);
});
