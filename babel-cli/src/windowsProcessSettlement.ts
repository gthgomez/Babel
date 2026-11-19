/**
 * Windows descendant settlement.
 *
 * `taskkill /T /F` terminates the tree it can see at call time, and Windows
 * has no process-group signal semantics. A supervisor must therefore confirm
 * that no descendant of the owned root remains before it reports a cancelled
 * or timed-out command as settled. Windows keeps `ParentProcessId` on orphaned
 * children, so a descendant census rooted at the owned pid still finds
 * grandchildren after the direct child exits.
 *
 * Pure helpers with injectable probes keep the contract testable off Windows.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { getSafeEnv } from './utils/safeEnv.js';
import { isProcessAlive } from './processTree.js';

export interface WindowsDescendantProbe {
  /** Descendant process ids, or null when the census could not be confirmed. */
  listDescendants: (rootPid: number, timeoutMs?: number) => number[] | null;
  /** Best-effort kill of one process and its visible tree. */
  kill: (pid: number) => boolean;
}

export interface WindowsDescendantSettlement {
  /** True only when a complete census observed zero remaining descendants. */
  confirmed: boolean;
  /** Descendants that survived the bounded kill rounds. */
  remaining: number[];
  /** True when the census itself was unavailable (never treated as success). */
  probeUnavailable: boolean;
  killsAttempted: number;
}

export interface WindowsSettlementOptions {
  probe?: WindowsDescendantProbe;
  /** Bounded kill rounds; each round re-censuses. */
  rounds?: number;
  /** Total census budget. A slow/unavailable probe reports `probeUnavailable`. */
  budgetMs?: number;
  /** Delay between rounds (ms). */
  roundDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const MAX_CENSUS_OUTPUT_BYTES = 64 * 1024;

export interface WindowsProcessRow {
  processId: number;
  parentProcessId: number;
}

/**
 * Walk the complete parent chain from `rootPid` over one process-table
 * snapshot. Windows does not reparent orphans, so the dead leader's children
 * still point at its pid. Pure and order-independent for Linux tests.
 */
export function descendantPidsFromRows(rootPid: number, rows: readonly WindowsProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.processId) || !Number.isSafeInteger(row.parentProcessId)) continue;
    const list = children.get(row.parentProcessId);
    if (list) list.push(row.processId);
    else children.set(row.parentProcessId, [row.processId]);
  }
  const seen = new Set<number>();
  const front = [rootPid];
  while (front.length > 0) {
    const next: number[] = [];
    for (const parentId of front) {
      for (const child of children.get(parentId) ?? []) {
        if (child > 0 && !seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    front.length = 0;
    front.push(...next);
  }
  return [...seen].sort((left, right) => left - right);
}

/** Parse `wmic process get ProcessId,ParentProcessId /format:csv` output. */
export function parseWmicProcessRows(stdout: string): WindowsProcessRow[] | null {
  const rows: WindowsProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(',');
    if (columns.length < 3) continue;
    const processId = Number(columns[columns.length - 1]);
    const parentProcessId = Number(columns[columns.length - 2]);
    if (!Number.isSafeInteger(processId) || !Number.isSafeInteger(parentProcessId)) continue;
    rows.push({ processId, parentProcessId });
  }
  return rows.length > 0 ? rows : null;
}

/**
 * Fast native table query. WMIC is optional on newer Windows; the CIM path
 * below remains the fallback.
 */
function listViaWmic(rootPid: number, timeoutMs: number): number[] | null {
  const systemRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
  const wmic = resolve(systemRoot, 'System32', 'wbem', 'wmic.exe');
  const result = spawnSync(wmic, ['process', 'get', 'ProcessId,ParentProcessId', '/format:csv'], {
    encoding: 'utf8',
    timeout: Math.max(250, Math.min(5_000, timeoutMs)),
    maxBuffer: MAX_CENSUS_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
    env: getSafeEnv(),
  });
  if (result.error || result.status !== 0) return null;
  const rows = parseWmicProcessRows(result.stdout ?? '');
  return rows ? descendantPidsFromRows(rootPid, rows) : null;
}

function powershellExecutable(): string {
  const systemRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
  return resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Enumerate every descendant of `rootPid` in one CIM snapshot.
 * Returns null when the probe cannot run or its output is not a complete list.
 */
export function listWindowsDescendantPids(rootPid: number, timeoutMs = 15_000): number[] | null {
  if (process.platform !== 'win32' || !Number.isSafeInteger(rootPid) || rootPid <= 0) return null;
  const startedAt = Date.now();
  const fast = listViaWmic(rootPid, timeoutMs);
  if (fast !== null) return fast;
  timeoutMs = Math.max(250, timeoutMs - (Date.now() - startedAt));
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$root = ${rootPid};`,
    '$seen = New-Object System.Collections.Generic.HashSet[int];',
    '$front = @($root);',
    'while ($front.Count -gt 0) {',
    '  $next = @();',
    '  foreach ($parentId in $front) {',
    '    $kids = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$parentId" | Select-Object -ExpandProperty ProcessId);',
    '    foreach ($child in $kids) {',
    '      if ($child -gt 0 -and $seen.Add([int]$child)) { $next += [int]$child }',
    '    }',
    '  }',
    '  $front = $next;',
    '}',
    'Write-Output (($seen | Sort-Object) -join ",");',
  ].join(' ');
  const result = spawnSync(
    powershellExecutable(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      timeout: Math.max(250, timeoutMs),
      maxBuffer: MAX_CENSUS_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      env: getSafeEnv(),
    },
  );
  if (result.error || result.status !== 0) return null;
  const output = (result.stdout ?? '').trim();
  if (output.length === 0) return [];
  if (!/^\d+(?:,\d+)*$/.test(output)) return null;
  const pids = output.split(',').map(Number);
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) return null;
  return [...new Set(pids)];
}

function killWindowsProcessTree(pid: number): boolean {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const systemRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
  const taskkill = resolve(systemRoot, 'System32', 'taskkill.exe');
  try {
    const result = spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      env: getSafeEnv(),
      timeout: 1_500,
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

/**
 * Observation phase: return every descendant of the owned root without
 * killing anything. Callers run this BEFORE taskkill so a live chain is seen;
 * `null` means the census was incomplete and must fail closed.
 */
export async function observeWindowsDescendants(
  rootPid: number,
  options: { probe?: WindowsDescendantProbe; budgetMs?: number } = {},
): Promise<number[] | null> {
  const probe = options.probe ?? defaultProbe;
  return probe.listDescendants(rootPid, Math.max(250, options.budgetMs ?? 20_000));
}

/**
 * Confirmation phase: prove observed descendant pids are gone after the tree
 * kill. A pid check is cheap and does not depend on WMI, so the post-kill
 * bound can stay short. Unobserved survivors are killed once, then rechecked.
 */
export async function confirmWindowsDescendants(
  descendantPids: readonly number[],
  options: { kill?: (pid: number) => boolean; timeoutMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ confirmed: boolean; remaining: number[] }> {
  const kill = options.kill ?? killWindowsProcessTree;
  const timeoutMs = Math.max(100, options.timeoutMs ?? 2_000);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, ms); }));
  const deadline = Date.now() + timeoutMs;
  let remaining = [...new Set(descendantPids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (let round = 0; round < 3; round++) {
    remaining = remaining.filter(isProcessAlive);
    if (remaining.length === 0) return { confirmed: true, remaining: [] };
    if (Date.now() >= deadline) break;
    for (const pid of remaining) kill(pid);
    await wait(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  remaining = remaining.filter(isProcessAlive);
  return { confirmed: remaining.length === 0, remaining };
}

const defaultProbe: WindowsDescendantProbe = {
  listDescendants: listWindowsDescendantPids,
  kill: killWindowsProcessTree,
};

/**
 * Terminate and confirm every descendant of an owned Windows root.
 *
 * Observation uses a fast WMIC table when present, falling back to filtered
 * CIM queries; either walks the full parent chain. Never returns
 * `confirmed: true` from a failed or incomplete census: an unconfirmed tree
 * stays visible to the caller so it can fail closed.
 */
export async function settleWindowsDescendants(
  rootPid: number,
  options: WindowsSettlementOptions = {},
): Promise<WindowsDescendantSettlement> {
  const probe = options.probe ?? defaultProbe;
  const rounds = Math.max(1, options.rounds ?? 1);
  const roundDelayMs = Math.max(0, options.roundDelayMs ?? 50);
  const deadline = Date.now() + Math.max(250, options.budgetMs ?? 30_000);
  const probeOnce = (): number[] | null =>
    probe.listDescendants(rootPid, Math.max(250, deadline - Date.now()));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, ms); }));
  let killsAttempted = 0;

  for (let round = 0; round < rounds; round++) {
    const descendants = probeOnce();
    if (descendants === null) {
      return { confirmed: false, remaining: [], probeUnavailable: true, killsAttempted };
    }
    if (descendants.length === 0) {
      return { confirmed: true, remaining: [], probeUnavailable: false, killsAttempted };
    }
    for (const pid of descendants) {
      killsAttempted += 1;
      probe.kill(pid);
    }
    if (round + 1 < rounds && roundDelayMs > 0) await wait(roundDelayMs);
  }

  const remainder = probeOnce();
  if (remainder === null) {
    return { confirmed: false, remaining: [], probeUnavailable: true, killsAttempted };
  }
  return { confirmed: remainder.length === 0, remaining: remainder, probeUnavailable: false, killsAttempted };
}
