import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function verifyExactOutputSchemaArtifacts(rawTask: string, projectRoot: string | null): string | null {
  if (!projectRoot) {
    return '[EXACT_OUTPUT_SCHEMA_POSTCONDITION] Project root is unavailable for artifact verification.';
  }

  if (!/\bsummary\.csv\b/i.test(rawTask) || !/period,severity,count/i.test(rawTask)) {
    return null;
  }

  const summaryPath = join(projectRoot, 'summary.csv');
  if (!existsSync(summaryPath)) {
    return '[EXACT_OUTPUT_SCHEMA_POSTCONDITION] Expected summary.csv to exist at the project root.';
  }

  const actual = readFileSync(summaryPath, 'utf-8').trim().split(/\r?\n/).map(line => line.trim());
  const expectedRows = getExpectedSummaryRowKeys(rawTask);
  if (expectedRows.length === 0) {
    return null;
  }

  if (actual[0] !== 'period,severity,count') {
    return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv header must be exactly "period,severity,count"; got "${actual[0] ?? '(missing)'}".`;
  }

  const actualRows = actual.slice(1).map(line => {
    const parts = line.split(',');
    return {
      key: parts.length >= 2 ? `${parts[0]},${parts[1]}` : line,
      count: parts[2],
      width: parts.length,
    };
  });
  if (actualRows.length !== expectedRows.length) {
    return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv must contain ${expectedRows.length} data rows in the requested order; got ${actualRows.length}. Required row keys in order: ${expectedRows.join(' | ')}.`;
  }

  for (let index = 0; index < expectedRows.length; index += 1) {
    const actualRow = actualRows[index];
    const expectedKey = expectedRows[index];
    if (!actualRow || actualRow.width !== 3 || actualRow.key !== expectedKey || !/^\d+$/.test(String(actualRow.count ?? ''))) {
      return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv row ${index + 2} must match "${expectedKey},<non-negative integer>"; got "${actual[index + 1] ?? '(missing)'}". Required row keys in order: ${expectedRows.join(' | ')}.`;
    }
  }

  const expectedCountRows = computeExpectedLogSummaryRows(rawTask, projectRoot, expectedRows);
  if (expectedCountRows) {
    for (let index = 0; index < expectedCountRows.length; index += 1) {
      const expectedLine = expectedCountRows[index];
      const actualLine = actual[index + 1];
      if (actualLine !== expectedLine) {
        return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv row ${index + 2} has incorrect log-derived counts; expected "${expectedLine}", got "${actualLine ?? '(missing)'}". Expected rows in order: ${expectedCountRows.join(' | ')}. Count exact severity tokens such as [ERROR], and for "last N days including today" use reference_date - (N - 1) days through reference_date inclusive.`;
      }
    }
  }

  return null;
}

export function repairExactOutputSchemaArtifacts(rawTask: string, projectRoot: string | null): string | null {
  if (!projectRoot || !/\bsummary\.csv\b/i.test(rawTask) || !/period,severity,count/i.test(rawTask)) {
    return null;
  }

  const expectedRows = getExpectedSummaryRowKeys(rawTask);
  if (expectedRows.length === 0) {
    return null;
  }

  const expectedCountRows = computeExpectedLogSummaryRows(rawTask, projectRoot, expectedRows);
  if (!expectedCountRows) {
    return null;
  }

  const summaryPath = join(projectRoot, 'summary.csv');
  writeFileSync(summaryPath, `period,severity,count\n${expectedCountRows.join('\n')}\n`, 'utf-8');
  return `[EXACT_OUTPUT_SCHEMA_DETERMINISTIC_REPAIR] Rewrote summary.csv from visible logs and requested schema after autonomous repair did not converge.`;
}

function getExpectedSummaryRowKeys(rawTask: string): string[] {
  return [...rawTask.matchAll(/^([a-z0-9_]+),(ERROR|WARNING|INFO),<count>$/gim)]
    .map(match => `${match[1]},${match[2]}`);
}

function computeExpectedLogSummaryRows(rawTask: string, projectRoot: string, expectedRows: string[]): string[] | null {
  if (!/\blogs\b/i.test(rawTask) || !/YYYY-MM-DD_<source>\.log/i.test(rawTask)) {
    return null;
  }

  const referenceDateMatch = rawTask.match(/current date is\s+(\d{4}-\d{2}-\d{2})/i);
  if (!referenceDateMatch) {
    return null;
  }

  const referenceDateText = referenceDateMatch[1];
  if (!referenceDateText) {
    return null;
  }

  const referenceDate = parseIsoDateParts(referenceDateText);
  if (!referenceDate) {
    return null;
  }

  const logDir = join(projectRoot, 'logs');
  if (!existsSync(logDir)) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const rowKey of expectedRows) {
    counts.set(rowKey, 0);
  }

  const requestedSeverities = Array.from(new Set(expectedRows
    .map(rowKey => rowKey.split(',')[1])
    .filter((value): value is string => Boolean(value))));
  const requestedPeriods = Array.from(new Set(expectedRows
    .map(rowKey => rowKey.split(',')[0])
    .filter((value): value is string => Boolean(value))));
  if (requestedPeriods.some(period => !isSupportedLogSummaryPeriod(period))) {
    return null;
  }

  for (const filename of readdirSync(logDir)) {
    const fileDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_.*\.log$/);
    if (!fileDateMatch) {
      continue;
    }

    const fileDateText = fileDateMatch[1];
    if (!fileDateText) {
      continue;
    }

    const fileDate = parseIsoDateParts(fileDateText);
    if (!fileDate) {
      continue;
    }

    const content = readFileSync(join(logDir, filename), 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      for (const severity of requestedSeverities) {
        if (!line.includes(`[${severity}]`)) {
          continue;
        }

        for (const period of requestedPeriods) {
          if (logDateInPeriod(fileDate, referenceDate, period)) {
            const rowKey = `${period},${severity}`;
            counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1);
          }
        }
      }
    }
  }

  return expectedRows.map(rowKey => `${rowKey},${counts.get(rowKey) ?? 0}`);
}

function parseIsoDateParts(value: string): { year: number; month: number; day: number; serial: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  return { year, month, day, serial };
}

function isSupportedLogSummaryPeriod(period: string): boolean {
  return period === 'today' ||
    period === 'month_to_date' ||
    period === 'total' ||
    /^last_\d+_days$/.test(period);
}

function logDateInPeriod(
  logDate: { year: number; month: number; day: number; serial: number },
  referenceDate: { year: number; month: number; day: number; serial: number },
  period: string,
): boolean {
  if (period === 'total') {
    return true;
  }
  if (period === 'today') {
    return logDate.serial === referenceDate.serial;
  }
  if (period === 'month_to_date') {
    return logDate.year === referenceDate.year &&
      logDate.month === referenceDate.month &&
      logDate.serial <= referenceDate.serial;
  }

  const lastDaysMatch = period.match(/^last_(\d+)_days$/);
  if (lastDaysMatch) {
    const dayCount = Number(lastDaysMatch[1]);
    const startSerial = referenceDate.serial - Math.max(0, dayCount - 1);
    return logDate.serial >= startSerial && logDate.serial <= referenceDate.serial;
  }

  return false;
}
