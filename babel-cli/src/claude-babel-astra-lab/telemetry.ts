import { execFileSync } from 'node:child_process';
import { resourceUsage, memoryUsage } from 'node:process';
import type { LabMetric, ResourceMetrics } from './contracts.js';

export interface TelemetrySample {
  pid: number;
  processCount: LabMetric;
  childProcessCount: LabMetric;
  workingSet: LabMetric;
  cpuTimeMs: LabMetric;
  diskReadBytes: LabMetric;
  diskWriteBytes: LabMetric;
}

function processCount(): LabMetric {
  if (process.platform !== 'win32') return 'UNKNOWN';
  try {
    const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch {
    return 'UNKNOWN';
  }
}

export function sampleTelemetry(pid = process.pid): TelemetrySample {
  const usage = resourceUsage();
  const rss = memoryUsage().rss;
  const maxRss = Number.isFinite(usage.maxRSS) ? usage.maxRSS * 1024 : null;
  return {
    pid,
    processCount: processCount(),
    childProcessCount: 'UNKNOWN',
    workingSet: maxRss === null ? rss : Math.max(rss, maxRss),
    cpuTimeMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
    diskReadBytes: 'UNKNOWN',
    diskWriteBytes: 'UNKNOWN',
  };
}

export function aggregateTelemetry(samples: readonly TelemetrySample[], cleanup: ResourceMetrics['processCleanup'] = 'UNKNOWN'): ResourceMetrics {
  if (samples.length === 0) {
    return {
      processCount: 'UNKNOWN', childProcessCount: 'UNKNOWN', peakWorkingSet: 'UNKNOWN', cpuTimeMs: 'UNKNOWN',
      diskReadBytes: 'UNKNOWN', diskWriteBytes: 'UNKNOWN', processCleanup: cleanup,
    };
  }
  const max = (field: keyof TelemetrySample): LabMetric => {
    const values = samples.map((sample) => sample[field]).filter((value): value is number => typeof value === 'number');
    return values.length > 0 ? Math.max(...values) : 'UNKNOWN';
  };
  const last = samples[samples.length - 1]!;
  return {
    processCount: max('processCount'),
    childProcessCount: max('childProcessCount'),
    peakWorkingSet: max('workingSet'),
    cpuTimeMs: max('cpuTimeMs'),
    diskReadBytes: max('diskReadBytes'),
    diskWriteBytes: max('diskWriteBytes'),
    processCleanup: cleanup,
    ...(typeof last.childProcessCount === 'number' ? {} : { threadCount: 'UNKNOWN' as const }),
  };
}
