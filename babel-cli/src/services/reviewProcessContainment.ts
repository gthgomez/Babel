import { spawn, type ChildProcess } from 'node:child_process'

import { getSafeEnv } from '../utils/safeEnv.js'

export type ReviewProcessContainmentKind =
  | 'posix_process_group'
  | 'windows_job_object'
  | 'windows_taskkill_fallback'

export interface ReviewProcessContainment {
  kind: ReviewProcessContainmentKind
  error?: string
  release(): void
}

const WINDOWS_JOB_HELPER_TIMEOUT_MS = 5_000
const POSIX_WATCHDOG_START_TIMEOUT_MS = 5_000

function windowsJobHelperScript(workerPid: number, controllerPid: number): string {
  return `$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class BabelReviewJob {
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint PROCESS_TERMINATE = 0x0001;
  private const uint PROCESS_SET_QUOTA = 0x0100;
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public IntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int infoClass,
    IntPtr info,
    uint length
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  private static bool IsAlive(int pid) {
    try {
      using (Process process = Process.GetProcessById(pid)) return !process.HasExited;
    } catch {
      return false;
    }
  }

  public static void Hold(int workerPid, int controllerPid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr process = IntPtr.Zero;
    IntPtr infoPointer = IntPtr.Zero;
    try {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int infoLength = Marshal.SizeOf(info);
      infoPointer = Marshal.AllocHGlobal(infoLength);
      Marshal.StructureToPtr(info, infoPointer, false);
      if (!SetInformationJobObject(job, 9, infoPointer, (uint)infoLength)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      process = OpenProcess(
        PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
        false,
        workerPid
      );
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(job, process)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      Console.Out.WriteLine("ASSIGNED");
      Console.Out.Flush();
      while (IsAlive(workerPid) && IsAlive(controllerPid)) Thread.Sleep(50);
    } finally {
      if (infoPointer != IntPtr.Zero) Marshal.FreeHGlobal(infoPointer);
      if (process != IntPtr.Zero) CloseHandle(process);
      CloseHandle(job);
    }
  }
}
'@
Add-Type -TypeDefinition $source
[BabelReviewJob]::Hold(${workerPid}, ${controllerPid})`
}

function stopHelper(helper: ChildProcess): void {
  try {
    helper.kill()
  } catch {
    // The helper may already have closed after its worker exited.
  }
}

function posixWatchdogScript(): string {
  return `const workerPid = Number(process.argv[1]);
const controllerPid = Number(process.argv[2]);
if (!Number.isSafeInteger(workerPid) || workerPid < 1 || !Number.isSafeInteger(controllerPid) || controllerPid < 1) process.exit(64);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code !== 'ESRCH'; }
};
let stopping = false;
const stopTree = () => {
  if (stopping) return;
  stopping = true;
  try { process.kill(-workerPid, 'SIGTERM'); } catch {}
  const escalation = setTimeout(() => {
    try { process.kill(-workerPid, 'SIGKILL'); } catch {}
    try { process.kill(workerPid, 'SIGKILL'); } catch {}
    process.exit(0);
  }, 500);
  escalation.unref?.();
};
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {
  if (!alive(workerPid)) process.exit(0);
  if (!alive(controllerPid)) stopTree();
}, 25);
process.stdout.write('READY\\n');`
}

async function attachPosixReviewWatchdog(
  workerPid: number,
  controllerPid: number,
): Promise<ReviewProcessContainment> {
  const helper = spawn(
    process.execPath,
    ['--eval', posixWatchdogScript(), String(workerPid), String(controllerPid)],
    {
      detached: true,
      env: getSafeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const started = await new Promise<{ ready: boolean; error?: string }>((resolveStarted) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const settle = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveStarted({ ready, ...(stderr.trim() ? { error: stderr.trim().slice(-2_000) } : {}) })
    }
    const timer = setTimeout(() => settle(false), POSIX_WATCHDOG_START_TIMEOUT_MS)
    timer.unref?.()
    helper.stdout?.setEncoding('utf8')
    helper.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.split(/\r?\n/).includes('READY')) settle(true)
    })
    helper.stderr?.setEncoding('utf8')
    helper.stderr?.on('data', (chunk: string) => { stderr += chunk })
    helper.once('error', () => settle(false))
    helper.once('close', () => settle(false))
  })
  if (!started.ready) {
    stopHelper(helper)
    throw new Error(`POSIX review containment watchdog could not start${started.error ? `: ${started.error}` : '.'}`)
  }
  helper.stdout?.destroy()
  helper.stderr?.destroy()
  helper.unref()
  return Object.freeze({
    kind: 'posix_process_group' as const,
    release(): void {
      stopHelper(helper)
    },
  })
}

/**
 * Attach independent host-lifetime containment before allowing a review worker
 * to start. POSIX uses a detached watchdog plus the worker process group;
 * Windows uses a kill-on-close Job Object held by an independent helper.
 */
export async function attachReviewProcessContainment(
  workerPid: number,
  controllerPid = process.pid,
): Promise<ReviewProcessContainment> {
  if (process.platform === 'win32') {
    return attachWindowsReviewJobObject(workerPid, controllerPid)
  }
  return attachPosixReviewWatchdog(workerPid, controllerPid)
}

/**
 * Attach a Windows review worker to a kill-on-close Job Object held by an
 * independent helper. If native assignment is unavailable, callers retain the
 * existing taskkill tree fallback and the returned kind reports that fact.
 */
export async function attachWindowsReviewJobObject(
  workerPid: number,
  controllerPid = process.pid,
): Promise<ReviewProcessContainment> {
  if (process.platform !== 'win32') {
    return Object.freeze({ kind: 'posix_process_group' as const, release() {} })
  }
  const encoded = Buffer.from(windowsJobHelperScript(workerPid, controllerPid), 'utf16le').toString('base64')
  const helperEnv = getSafeEnv()
  // Some host sandboxes virtualize C:\\Windows\\Temp for the controller but not
  // for PowerShell's C# compiler child. Compile transient Add-Type files in the
  // trusted controller cwd so both processes observe the same filesystem.
  helperEnv['TEMP'] = process.cwd()
  helperEnv['TMP'] = process.cwd()
  const helper = spawn(
    process.env['SystemRoot'] ? `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      env: helperEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  const assignment = await new Promise<{ assigned: boolean; error?: string }>((resolveAssigned) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const settle = (assigned: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveAssigned({ assigned, ...(stderr.trim() ? { error: stderr.trim().slice(-2_000) } : {}) })
    }
    const timer = setTimeout(() => settle(false), WINDOWS_JOB_HELPER_TIMEOUT_MS)
    timer.unref?.()
    helper.stdout?.setEncoding('utf8')
    helper.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.split(/\r?\n/).includes('ASSIGNED')) settle(true)
    })
    helper.stderr?.setEncoding('utf8')
    helper.stderr?.on('data', (chunk: string) => { stderr += chunk })
    helper.once('error', () => settle(false))
    helper.once('close', () => settle(false))
  })

  if (!assignment.assigned) {
    stopHelper(helper)
    return Object.freeze({
      kind: 'windows_taskkill_fallback' as const,
      ...(assignment.error ? { error: assignment.error } : {}),
      release() {},
    })
  }

  return Object.freeze({
    kind: 'windows_job_object' as const,
    release(): void {
      stopHelper(helper)
    },
  })
}
