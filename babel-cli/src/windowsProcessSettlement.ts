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

export interface WindowsDescendantProbe {
  /** Descendant process ids, or null when the census could not be confirmed. */
  listDescendants: (rootPid: number) => number[] | null;
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
  /** Delay between rounds (ms). */
  roundDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const MAX_CENSUS_OUTPUT_BYTES = 64 * 1024;

function powershellExecutable(): string {
  const systemRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
  return resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Enumerate every descendant of `rootPid` in one CIM snapshot.
 * Returns null when the probe cannot run or its output is not a complete list.
 */
export function listWindowsDescendantPids(rootPid: number): number[] | null {
  if (process.platform !== 'win32' || !Number.isSafeInteger(rootPid) || rootPid <= 0) return null;
  const script = [
    '$ErrorActionPreference = "Stop";',
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId);',
    '$kids = @{};',
    'foreach ($row in $rows) {',
    '  $parent = [int]$row.ParentProcessId;',
    '  if (-not $kids.ContainsKey($parent)) { $kids[$parent] = New-Object System.Collections.ArrayList }',
    '  [void]$kids[$parent].Add([int]$row.ProcessId);',
    '}',
    `$roots = @(${rootPid});`,
    '$seen = New-Object System.Collections.Generic.HashSet[int];',
    '$front = @($roots);',
    'while ($front.Count -gt 0) {',
    '  $next = @();',
    '  foreach ($pidValue in $front) {',
    '    if (-not $kids.ContainsKey($pidValue)) { continue }',
    '    foreach ($child in $kids[$pidValue]) {',
    '      if ($child -gt 0 -and $seen.Add($child)) { $next += $child }',
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
      timeout: 5_000,
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

const defaultProbe: WindowsDescendantProbe = {
  listDescendants: listWindowsDescendantPids,
  kill: killWindowsProcessTree,
};

/**
 * Terminate and confirm every descendant of an owned Windows root.
 *
 * Never returns `confirmed: true` from a failed or incomplete census: an
 * unconfirmed tree stays visible to the caller so it can fail closed.
 */
export async function settleWindowsDescendants(
  rootPid: number,
  options: WindowsSettlementOptions = {},
): Promise<WindowsDescendantSettlement> {
  const probe = options.probe ?? defaultProbe;
  const rounds = Math.max(1, options.rounds ?? 3);
  const roundDelayMs = Math.max(0, options.roundDelayMs ?? 100);
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, ms); }));
  let killsAttempted = 0;

  for (let round = 0; round < rounds; round++) {
    const descendants = probe.listDescendants(rootPid);
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

  const remainder = probe.listDescendants(rootPid);
  if (remainder === null) {
    return { confirmed: false, remaining: [], probeUnavailable: true, killsAttempted };
  }
  return { confirmed: remainder.length === 0, remaining: remainder, probeUnavailable: false, killsAttempted };
}
