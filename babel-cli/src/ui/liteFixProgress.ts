import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

import { SpinnerRenderer } from './spinner.js';
import { OutputBuffer } from './outputBuffer.js';
import type { LiteToolStreamEvent } from './liteToolStream.js';

export type LiteFixStage = 'scoped' | 'model' | 'patch' | 'verify' | 'checkpoint';

export interface LiteFixProgressReporter {
  report(stage: LiteFixStage, detail?: string): void;
  reportToolCall?(event: LiteToolStreamEvent): void;
  finish(status: 'pass' | 'fail', message?: string): void;
  bindRunDir(runDir: string): void;
  getTranscript(): string[];
  getProgressSteps(): string[];
}

export interface LiteFixProgressOptions {
  json?: boolean;
  stream?: boolean;
  /** Append timestamped lines without spinner (verbose REPL mode). */
  appendOnly?: boolean;
}

function stageSpinnerLabel(stage: LiteFixStage, detail?: string): string {
  switch (stage) {
    case 'scoped':
      return detail ? `Scoped ${detail}` : 'Scoped target file…';
    case 'model':
      return detail ?? 'Calling model…';
    case 'patch':
      return detail ?? 'Applying patch…';
    case 'verify':
      return detail ?? 'Running verifier…';
    case 'checkpoint':
      return detail ?? 'Saving checkpoint…';
  }
}

function stageSummaryLine(stage: LiteFixStage, detail?: string): string {
  switch (stage) {
    case 'scoped':
      return detail ? `Scoped ${detail}` : 'Scoped target file';
    case 'model':
      return detail === 'Model patch ready' ? detail : (detail ?? 'Model patch ready');
    case 'patch':
      return detail ?? 'Applied patch';
    case 'verify':
      return detail ?? 'Verifier complete';
    case 'checkpoint':
      return detail ?? 'Checkpoint saved';
  }
}

function formatElapsed(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function formatToolCallLine(event: LiteToolStreamEvent): string {
  const statusLabel =
    event.status === 'running'
      ? '…'
      : event.status === 'pass'
        ? 'ok'
        : event.status === 'blocked'
          ? 'blocked'
          : 'fail';
  const target = event.target.length > 72 ? `${event.target.slice(0, 69)}…` : event.target;
  return `${event.tool} ${target} (${statusLabel})`;
}

export function createNoopLiteFixProgress(): LiteFixProgressReporter {
  return {
    report() {},
    finish() {},
    bindRunDir() {},
    getTranscript: () => [],
    getProgressSteps: () => [],
  };
}

export function createLiteFixProgress(
  options: LiteFixProgressOptions = {},
): LiteFixProgressReporter {
  if (options.json === true || options.stream === true) {
    return createRecordingLiteFixProgress({ silentStdout: true });
  }
  if (options.appendOnly === true) {
    return createRecordingLiteFixProgress({ silentStdout: false });
  }
  if (process.stdout.isTTY && !process.env['CI'] && !process.env['NO_COLOR']) {
    return createSpinnerLiteFixProgress();
  }
  return createRecordingLiteFixProgress({ silentStdout: false });
}

function createRecordingLiteFixProgress(input: { silentStdout: boolean }): LiteFixProgressReporter {
  const startTime = Date.now();
  const transcript: string[] = [];
  const progressSteps: string[] = [];
  let runDir: string | null = null;
  let eventIndex = 0;

  const emitStdout = (line: string): void => {
    if (input.silentStdout) {
      return;
    }
    const elapsed = (Date.now() - startTime) / 1000;
    OutputBuffer.getInstance().write(`[${formatElapsed(elapsed)}] ${line}\n`);
  };

  const appendProgressEvent = (message: string): void => {
    if (!runDir) {
      return;
    }
    try {
      mkdirSync(runDir, { recursive: true });
      const record = JSON.stringify({
        type: 'progress',
        index: eventIndex,
        message,
        source: 'lite_fix',
        ts: new Date().toISOString(),
      });
      eventIndex += 1;
      appendFileSync(join(runDir, 'progress.jsonl'), `${record}\n`, 'utf-8');
    } catch {
      // progress artifacts must not change run success
    }
  };

  return {
    report(stage, detail) {
      const spinnerLabel = stageSpinnerLabel(stage, detail);
      const summary = stageSummaryLine(stage, detail);
      transcript.push(spinnerLabel);
      progressSteps.push(summary);
      emitStdout(spinnerLabel);
      appendProgressEvent(summary);
    },
    reportToolCall(event) {
      const line = formatToolCallLine(event);
      transcript.push(line);
      progressSteps.push(line);
      emitStdout(line);
      appendProgressEvent(line);
    },
    finish(status, message) {
      const line = message ?? (status === 'pass' ? 'Fix run complete' : 'Fix run failed');
      transcript.push(line);
      progressSteps.push(line);
      emitStdout(line);
      appendProgressEvent(line);
    },
    bindRunDir(nextRunDir) {
      runDir = resolve(nextRunDir);
    },
    getTranscript() {
      return [...transcript];
    },
    getProgressSteps() {
      return [...progressSteps].slice(0, 6);
    },
  };
}

function createSpinnerLiteFixProgress(): LiteFixProgressReporter {
  const transcript: string[] = [];
  const progressSteps: string[] = [];
  let runDir: string | null = null;
  let eventIndex = 0;
  const spinner = new SpinnerRenderer({
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    interval: 80,
    stream: process.stdout,
  });
  spinner.setText('Preparing fix…');

  const appendProgressEvent = (message: string): void => {
    if (!runDir) {
      return;
    }
    try {
      mkdirSync(runDir, { recursive: true });
      const record = JSON.stringify({
        type: 'progress',
        index: eventIndex,
        message,
        source: 'lite_fix',
        ts: new Date().toISOString(),
      });
      eventIndex += 1;
      appendFileSync(join(runDir, 'progress.jsonl'), `${record}\n`, 'utf-8');
    } catch {
      // progress artifacts must not change run success
    }
  };

  return {
    report(stage, detail) {
      const spinnerLabel = stageSpinnerLabel(stage, detail);
      const summary = stageSummaryLine(stage, detail);
      transcript.push(spinnerLabel);
      progressSteps.push(summary);
      spinner.update(spinnerLabel);
      appendProgressEvent(summary);
    },
    reportToolCall(event) {
      const line = formatToolCallLine(event);
      transcript.push(line);
      progressSteps.push(line);
      spinner.update(line);
      appendProgressEvent(line);
    },
    finish(status, message) {
      const line = message ?? (status === 'pass' ? 'Fix run complete' : 'Fix run failed');
      transcript.push(line);
      progressSteps.push(line);
      spinner.stop(line);
      appendProgressEvent(line);
    },
    bindRunDir(nextRunDir) {
      runDir = resolve(nextRunDir);
      spinner.start();
    },
    getTranscript() {
      return [...transcript];
    },
    getProgressSteps() {
      return [...progressSteps].slice(0, 6);
    },
  };
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (process.platform === 'win32') {
    const rootNorm = resolvedRoot.toLowerCase();
    const candidateNorm = resolvedCandidate.toLowerCase();
    return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}${sep}`);
  }
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !resolve(resolvedCandidate).startsWith('..'));
}
