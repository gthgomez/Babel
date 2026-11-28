/**
 * Own a Windows foreground command from creation through settlement.
 * The helper owns an unnamed, non-inherited kill-on-close Job Object. It
 * never resumes a command that could not be assigned and never looks up a PID
 * to terminate it. Closing the controller's pipe, including on process loss,
 * requests termination. The child cannot inherit that pipe or the job handle.
 */
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { hostWindowsSystem32Directory, isResolvedCommandCurrent, resolveCommandExecutable } from './authority/commandResolver.js'
import { buildWindowsCommandShellArgs, quoteWindowsCommandArg } from './utils/commandArgv.js'
import { getSafeEnv } from './utils/safeEnv.js'

const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
# The helper and command share native stderr. Module-loading progress must
# never add a PowerShell serialization frame to the command's output.
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$stage = 'input'
try {
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BabelForegroundJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfo {
    public uint Size;
    public IntPtr Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfoEx {
    public StartupInfo Startup;
    public IntPtr Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes {
    public int Size;
    public IntPtr Descriptor;
    public int Inherit;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool assigned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target,
    uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
    IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processSecurity,
    IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInfo info);

  static void Require(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static void Close(IntPtr handle) {
    if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
  }
  static IntPtr DuplicateStdHandle(int id) {
    IntPtr current = GetCurrentProcess(), target;
    Require(DuplicateHandle(current, GetStdHandle(id), current, out target, 0, true, 2), "duplicate child standard handle");
    return target;
  }
  static void WriteReceipt(string folder, string name, uint value) {
    string pending = Path.Combine(folder, name + ".tmp");
    File.WriteAllText(pending, value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    File.Move(pending, Path.Combine(folder, name));
  }

  public static void Run(string executable, string command, string cwd, string envBase64, string folder) {
    int stop = 0;
    var control = new Thread(() => {
      try { Console.In.Read(); }
      catch (IOException) {}
      finally { Interlocked.Exchange(ref stop, 1); }
    });
    control.IsBackground = true;
    control.Start();

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Require(job != IntPtr.Zero, "create command job");
    var process = new ProcessInfo();
    var startup = new StartupInfoEx();
    IntPtr handleList = IntPtr.Zero, jobList = IntPtr.Zero, env = IntPtr.Zero;
    bool attributesInitialized = false;
    try {
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "arm job kill-on-close");
      var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
      startup.Startup.Input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
      Require(startup.Startup.Input != new IntPtr(-1), "open child null input");
      startup.Startup.Output = DuplicateStdHandle(-11);
      startup.Startup.Error = DuplicateStdHandle(-12);
      startup.Startup.Size = (uint)Marshal.SizeOf(startup);
      startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
      IntPtr listSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref listSize);
      Require(listSize != IntPtr.Zero, "size command handle allowlist");
      startup.Attributes = Marshal.AllocHGlobal(listSize);
      Require(InitializeProcThreadAttributeList(startup.Attributes, 2, 0, ref listSize), "initialize command handle allowlist");
      attributesInitialized = true;
      IntPtr[] handles = { startup.Startup.Input, startup.Startup.Output, startup.Startup.Error };
      handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
      Marshal.Copy(handles, 0, handleList, handles.Length);
      Require(UpdateProcThreadAttribute(startup.Attributes, 0, new IntPtr(0x20002), handleList,
        new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero), "restrict inherited handles");
      // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns during creation. A helper that
      // dies between CreateProcess and ResumeThread cannot orphan a process.
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Require(UpdateProcThreadAttribute(startup.Attributes, 0, new IntPtr(0x2000D), jobList,
        new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "bind command creation to its job");
      env = Marshal.StringToHGlobalUni(Encoding.Unicode.GetString(Convert.FromBase64String(envBase64)));

      if (Volatile.Read(ref stop) != 0) { WriteReceipt(folder, "settled", 1); return; }
      // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
      Require(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
        true, 0x08080404, env, cwd, ref startup, out process), "create suspended command");
      bool assigned;
      Require(IsProcessInJob(process.Process, job, out assigned), "verify suspended command job");
      if (!assigned) throw new InvalidOperationException("Suspended command was not assigned to its job.");
      if (Volatile.Read(ref stop) == 0) {
        Require(ResumeThread(process.Thread) != UInt32.MaxValue, "resume owned command");
        WriteReceipt(folder, "started", process.Pid);
      }

      Stopwatch termination = null;
      var accounting = new Accounting();
      while (true) {
        Require(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(accounting), IntPtr.Zero),
          "query active command job processes");
        if (accounting.ActiveProcesses == 0) break;
        if (Volatile.Read(ref stop) != 0 && termination == null) {
          Require(TerminateJobObject(job, 1), "terminate owned command job");
          termination = Stopwatch.StartNew();
        }
        if (termination != null && termination.ElapsedMilliseconds >= 5000) {
          throw new InvalidOperationException("Owned Windows command job did not reach zero active processes.");
        }
        Thread.Sleep(20);
      }
      uint code;
      Require(GetExitCodeProcess(process.Process, out code), "read owned command exit code");
      WriteReceipt(folder, "settled", code);
    } finally {
      Close(job);
      Close(process.Thread);
      Close(process.Process);
      Close(startup.Startup.Input);
      Close(startup.Startup.Output);
      Close(startup.Startup.Error);
      if (attributesInitialized) DeleteProcThreadAttributeList(startup.Attributes);
      if (startup.Attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.Attributes);
      if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }
}
'@
$stage = 'compilation'
Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $source
$stage = 'launch handshake'
[IO.File]::WriteAllText([IO.Path]::Combine($request.folder, 'ready'), '1')
if ([Console]::In.Read() -eq 65) {
  $stage = 'job ownership or settlement'
  [BabelForegroundJob]::Run($request.executable, $request.command, $request.cwd, $request.environment, $request.folder)
} else {
  [IO.File]::WriteAllText([IO.Path]::Combine($request.folder, 'settled'), '1')
}
exit 0
} catch {
  $failure = $_.Exception.InnerException
  if ($failure -is [ComponentModel.Win32Exception]) {
    [Console]::Error.WriteLine("Windows command job $stage failed (Win32 $($failure.NativeErrorCode)).")
  } else {
    [Console]::Error.WriteLine("Windows command job $stage failed.")
  }
  exit 1
}
`

const encodedHelper = Buffer.from(WINDOWS_HELPER, 'utf16le').toString('base64')
const START_TIMEOUT_MS = 65_000

export interface OwnedWindowsCommand {
  child: ChildProcessWithoutNullStreams
  onStarted(callback: (pid: number) => void): void
  requestStop(): void
  launchError(): Error | undefined
  readExit(wrapperCode: number | null): number | null
}

/** Windows launch line with the established verbatim cmd.exe convention. */
export function buildOwnedWindowsInvocation(executable: string, args: string[], systemRoot: string): {
  executable: string
  command: string
} {
  if (/\.(cmd|bat)$/i.test(executable)) {
    args = buildWindowsCommandShellArgs([executable, ...args])
    executable = win32.join(systemRoot, 'System32', 'cmd.exe')
  }
  const argsText = win32.basename(executable).toLowerCase() === 'cmd.exe'
    ? args.join(' ')
    : args.map(quoteWindowsCommandArg).join(' ')
  return { executable, command: [quoteWindowsCommandArg(executable), argsText].filter(Boolean).join(' ') }
}

function readReceipt(folder: string, name: string): number | null {
  try {
    const value = readFileSync(join(folder, name), 'utf8')
    if (/^\d{1,10}$/.test(value) && Number(value) <= 0xffffffff) return Number(value)
  } catch {
    // Missing/unreadable settlement evidence never certifies completion.
  }
  return null
}

function encodeEnvironment(env: NodeJS.ProcessEnv): string {
  const keys = new Map<string, string>()
  for (const key of Object.keys(env).sort()) {
    const value = env[key]
    if (value === undefined || keys.has(key.toUpperCase())) continue
    keys.set(key.toUpperCase(), `${key}=${value}`)
  }
  return Buffer.from(`${[...keys.values()].join('\0')}\0\0`, 'utf16le').toString('base64')
}

/** Spawn the fixed supervisor with a separate, process-owned control pipe. */
export function spawnOwnedWindowsCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; validateExecutable?: () => boolean; release?: <T>(launch: () => T) => T | undefined },
  launch: (file: string, argv: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams,
): OwnedWindowsCommand {
  const system32 = hostWindowsSystem32Directory()
  if (!system32 || !win32.isAbsolute(system32)) throw new Error('Invalid Windows system directory for job supervision')
  const systemRoot = win32.dirname(system32)
  const resolved = resolveCommandExecutable(executable, { ...options, platform: 'win32' })
  if (!resolved) throw new Error(`Could not resolve Windows executable: ${executable}`)
  const invocation = buildOwnedWindowsInvocation(resolved.path, args, systemRoot)
  const folder = mkdtempSync(join(tmpdir(), 'babel-foreground-job-'))
  const helperEnv = { ...getSafeEnv(), TEMP: folder, TMP: folder }
  const host = win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let child: ChildProcessWithoutNullStreams
  try {
    child = launch(host, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encodedHelper], {
      cwd: folder, env: helperEnv, windowsHide: true,
    })
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    throw error
  }

  let pid = 0
  let stopped = false
  let launchReleased = false
  let launchError: Error | undefined
  let exitCode: number | null = null
  let startedCallback: ((pid: number) => void) | undefined
  const requestStop = (): void => {
    if (stopped) return
    stopped = true
    child.stdin.end()
  }
  const checkStarted = (): void => {
    if (!launchReleased && !stopped && readReceipt(folder, 'ready') === 1) {
      launchReleased = true
      // Recheck authority after the expensive native compilation, before
      // releasing the helper's suspended launch protocol.
      try {
        const release = (): true => {
          if (!isResolvedCommandCurrent(resolved) || options.validateExecutable?.() === false) {
            throw new Error('Windows command executable identity changed before launch')
          }
          child.stdin.write('A')
          return true
        }
        if (options.release) {
          if (options.release(release) !== true) throw new Error('Foreground launch authorization was revoked')
        } else release()
      } catch {
        launchError = new Error('Windows command executable identity could not be confirmed before launch')
        requestStop()
      }
    }
    if (pid) return
    pid = readReceipt(folder, 'started') ?? 0
    if (!pid) return
    clearTimeout(startDeadline)
    clearInterval(watcher)
    startedCallback?.(pid)
  }
  const watcher = setInterval(checkStarted, 25)
  watcher.unref()
  const startDeadline = setTimeout(() => child.kill(), START_TIMEOUT_MS)
  startDeadline.unref()
  child.once('close', code => {
    checkStarted()
    clearTimeout(startDeadline)
    clearInterval(watcher)
    if (code === 0) exitCode = readReceipt(folder, 'settled')
    try { rmSync(folder, { recursive: true, force: true }) } catch { /* Host cleanup is best-effort. */ }
  })
  // If the helper closes early, stdin EPIPE cannot take down the supervisor.
  child.stdin.on('error', () => {})
  child.stdin.write(JSON.stringify({ ...invocation, cwd: options.cwd, environment: encodeEnvironment(options.env), folder }) + '\n')
  return {
    child,
    onStarted(callback) { startedCallback = callback; if (pid) callback(pid) },
    requestStop,
    launchError() { return launchError },
    readExit(wrapperCode) { return wrapperCode === 0 ? exitCode : null },
  }
}
