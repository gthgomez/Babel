import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SpinnerRenderer } from './spinner.js';
import { OutputBuffer } from './outputBuffer.js';
import type { LiteToolStreamEvent } from './liteToolStream.js';

export type LiteSessionStage = 'route' | 'discover' | 'synthesize' | 'finish';

export interface LiteSessionProgressReporter {
  report(stage: LiteSessionStage, detail?: string): void;
  reportToolCall?(event: LiteToolStreamEvent): void;
  finish(status: 'pass' | 'fail', message?: string): void;
  bindRunDir(runDir: string): void;
  synthesizeFromPayload(payload: Record<string, unknown>): void;
  getTranscript(): string[];
  getProgressSteps(): string[];
}

export interface LiteSessionProgressOptions {
  json?: boolean;
  stream?: boolean;
  /** Append timestamped lines without spinner (verbose REPL mode). */
  appendOnly?: boolean;
}

function stageLabel(stage: LiteSessionStage, detail?: string): string {
  switch (stage) {
    case 'route':
      return detail ? `Route ${detail}` : 'Routing task…';
    case 'discover':
      return detail ?? 'Gathering repo context…';
    case 'synthesize':
      return detail ?? 'Synthesizing answer…';
    case 'finish':
      return detail ?? 'Run complete';
  }
}

function sessionLoopPhaseLabel(phase: string, status: string): string {
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1);
  return `${phaseLabel} ${status}`;
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

export function createNoopLiteSessionProgress(): LiteSessionProgressReporter {
  return {
    report() {},
    finish() {},
    bindRunDir() {},
    synthesizeFromPayload() {},
    getTranscript: () => [],
    getProgressSteps: () => [],
  };
}

export function createLiteSessionProgress(
  options: LiteSessionProgressOptions = {},
): LiteSessionProgressReporter {
  if (options.json === true || options.stream === true) {
    return createRecordingLiteSessionProgress({ silentStdout: true });
  }
  if (options.appendOnly === true) {
    return createRecordingLiteSessionProgress({ silentStdout: false });
  }
  if (process.stdout.isTTY && !process.env['CI'] && !process.env['NO_COLOR']) {
    return createSpinnerLiteSessionProgress();
  }
  return createRecordingLiteSessionProgress({ silentStdout: false });
}

function createRecordingLiteSessionProgress(input: {
  silentStdout: boolean;
}): LiteSessionProgressReporter {
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
        source: 'lite_session',
        ts: new Date().toISOString(),
      });
      eventIndex += 1;
      appendFileSync(join(runDir, 'progress.jsonl'), `${record}\n`, 'utf-8');
    } catch {
      // progress artifacts must not change run success
    }
  };

  const reporter: LiteSessionProgressReporter = {
    report(stage, detail) {
      const line = stageLabel(stage, detail);
      transcript.push(line);
      progressSteps.push(line);
      emitStdout(line);
      appendProgressEvent(line);
    },
    reportToolCall(event) {
      const line = formatToolCallLine(event);
      transcript.push(line);
      progressSteps.push(line);
      emitStdout(line);
      appendProgressEvent(line);
    },
    finish(status, message) {
      const line =
        message ?? (status === 'pass' ? 'Read-only run complete' : 'Read-only run failed');
      transcript.push(line);
      progressSteps.push(line);
      emitStdout(line);
      appendProgressEvent(line);
    },
    bindRunDir(nextRunDir) {
      runDir = resolve(nextRunDir);
    },
    synthesizeFromPayload(payload) {
      const steps = Array.isArray(payload['session_loop_steps'])
        ? payload['session_loop_steps']
        : [];
      for (const raw of steps) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          continue;
        }
        const record = raw as Record<string, unknown>;
        const phase = typeof record['phase'] === 'string' ? record['phase'] : null;
        const status = typeof record['status'] === 'string' ? record['status'] : null;
        if (!phase || !status) {
          continue;
        }
        const line = sessionLoopPhaseLabel(phase, status);
        if (progressSteps.includes(line)) {
          continue;
        }
        transcript.push(line);
        progressSteps.push(line);
        emitStdout(line);
        appendProgressEvent(line);
      }
    },
    getTranscript() {
      return [...transcript];
    },
    getProgressSteps() {
      return [...progressSteps].slice(0, 8);
    },
  };
  return reporter;
}

function createSpinnerLiteSessionProgress(): LiteSessionProgressReporter {
  const transcript: string[] = [];
  const progressSteps: string[] = [];
  let runDir: string | null = null;
  let eventIndex = 0;
  let started = false;
  const spinner = new SpinnerRenderer({
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    interval: 80,
    stream: process.stdout,
  });
  spinner.setText('Gathering context…');

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
        source: 'lite_session',
        ts: new Date().toISOString(),
      });
      eventIndex += 1;
      appendFileSync(join(runDir, 'progress.jsonl'), `${record}\n`, 'utf-8');
    } catch {
      // progress artifacts must not change run success
    }
  };

  const ensureStarted = (): void => {
    if (!started) {
      spinner.start();
      started = true;
    }
  };

  return {
    report(stage, detail) {
      const line = stageLabel(stage, detail);
      transcript.push(line);
      progressSteps.push(line);
      ensureStarted();
      spinner.update(line);
      appendProgressEvent(line);
    },
    reportToolCall(event) {
      const line = formatToolCallLine(event);
      transcript.push(line);
      progressSteps.push(line);
      ensureStarted();
      spinner.update(line);
      appendProgressEvent(line);
    },
    finish(status, message) {
      const line =
        message ?? (status === 'pass' ? 'Read-only run complete' : 'Read-only run failed');
      transcript.push(line);
      progressSteps.push(line);
      if (started) {
        spinner.stop(line);
      } else {
        OutputBuffer.getInstance().write(`${line}\n`);
      }
      appendProgressEvent(line);
    },
    bindRunDir(nextRunDir) {
      runDir = resolve(nextRunDir);
      ensureStarted();
    },
    synthesizeFromPayload(payload) {
      const steps = Array.isArray(payload['session_loop_steps'])
        ? payload['session_loop_steps']
        : [];
      for (const raw of steps) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          continue;
        }
        const record = raw as Record<string, unknown>;
        const phase = typeof record['phase'] === 'string' ? record['phase'] : null;
        const status = typeof record['status'] === 'string' ? record['status'] : null;
        if (!phase || !status) {
          continue;
        }
        const line = sessionLoopPhaseLabel(phase, status);
        if (progressSteps.includes(line)) {
          continue;
        }
        transcript.push(line);
        progressSteps.push(line);
        ensureStarted();
        spinner.update(line);
        appendProgressEvent(line);
      }
    },
    getTranscript() {
      return [...transcript];
    },
    getProgressSteps() {
      return [...progressSteps].slice(0, 8);
    },
  };
}
