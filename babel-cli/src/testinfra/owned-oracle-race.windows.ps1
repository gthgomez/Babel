param([string]$OracleScript, [string]$ProjectRoot, [string]$OutsideRoot, [string]$ManifestPath, [string]$ManifestHash, [string]$Mode)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Dot-sourcing the oracle binds its own ProjectRoot/ManifestPath/ManifestHash
# parameters in this scope. Preserve the actual probe arguments first.
$probeProjectRoot = $ProjectRoot
$probeManifestPath = $ManifestPath
$probeManifestHash = $ManifestHash
. $OracleScript
$attackSource = @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class BabelOwnedOracleRaceProbe {
  static volatile bool stop;
  static int attempts, transitions, failures, outsidePasses, calls, outsideReadOpens;
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle handle, uint control, byte[] input, uint size,
    IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetOverlappedResultEx(SafeFileHandle handle, IntPtr overlapped, out uint count, uint timeout, bool alertable);
  [StructLayout(LayoutKind.Sequential)] struct Overlapped {
    public UIntPtr Internal, InternalHigh; public uint Offset, OffsetHigh; public IntPtr Event;
  }
  sealed class OutsideReadWatch : IDisposable {
    readonly SafeFileHandle handle;
    readonly EventWaitHandle signal = new EventWaitHandle(false, EventResetMode.ManualReset);
    readonly IntPtr operation;
    readonly Thread observer;
    volatile bool canceled, completed, failed;
    public OutsideReadWatch(string path) {
      handle = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3, 0x40000000 | 0x80, IntPtr.Zero);
      if (handle.IsInvalid) throw new InvalidOperationException();
      operation = Marshal.AllocHGlobal(Marshal.SizeOf<Overlapped>());
      Marshal.StructureToPtr(new Overlapped { Event = signal.SafeWaitHandle.DangerousGetHandle() }, operation, false);
      uint ignored;
      bool immediate = DeviceIoControl(handle, 0x90000, null, 0, IntPtr.Zero, 0, out ignored, operation);
      if (immediate || Marshal.GetLastWin32Error() != 997) {
        handle.Dispose(); Marshal.FreeHGlobal(operation); signal.Dispose(); throw new InvalidOperationException();
      }
      observer = new Thread(() => {
        try {
          if (!signal.WaitOne(5000)) { failed = true; return; }
          uint count;
          bool success = GetOverlappedResultEx(handle, operation, out count, 2000, false);
          int error = success ? 0 : Marshal.GetLastWin32Error();
          completed = success || error == 995;
          if (!completed) { failed = true; return; }
          if (!canceled && success) Interlocked.Increment(ref outsideReadOpens);
        } catch { failed = true; }
        finally { handle.Dispose(); }
      });
      observer.IsBackground = true; observer.Start();
    }
    public void Dispose() {
      canceled = true;
      if (!handle.IsClosed) CancelIoEx(handle, operation);
      bool joined = observer.Join(3000);
      // Never free an OVERLAPPED structure until completion is confirmed.
      if (joined && completed) { Marshal.FreeHGlobal(operation); signal.Dispose(); }
      if (!joined || !completed || failed) throw new InvalidOperationException();
    }
  }
  static void MoveAttack(string root) {
    int stage = 0;
    while (!stop || stage != 0) {
      Interlocked.Increment(ref attempts);
      try {
        if (stage == 0) Directory.Move(Path.Combine(root, "sub"), Path.Combine(root, "retained"));
        else if (stage == 1) Directory.Move(Path.Combine(root, "junction"), Path.Combine(root, "sub"));
        else if (stage == 2) Directory.Move(Path.Combine(root, "sub"), Path.Combine(root, "junction"));
        else Directory.Move(Path.Combine(root, "retained"), Path.Combine(root, "sub"));
        stage = (stage + 1) % 4;
        Interlocked.Increment(ref transitions);
      } catch { Interlocked.Increment(ref failures); }
      Thread.Yield();
    }
  }
  static byte[] Junction(string target) {
    byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + target), print = Encoding.Unicode.GetBytes(target);
    byte[] buffer = new byte[16 + substitute.Length + 2 + print.Length + 2];
    Array.Copy(BitConverter.GetBytes(0xA0000003U), 0, buffer, 0, 4);
    Array.Copy(BitConverter.GetBytes((ushort)(buffer.Length - 8)), 0, buffer, 4, 2);
    Array.Copy(BitConverter.GetBytes((ushort)substitute.Length), 0, buffer, 10, 2);
    Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, buffer, 12, 2);
    Array.Copy(BitConverter.GetBytes((ushort)print.Length), 0, buffer, 14, 2);
    Array.Copy(substitute, 0, buffer, 16, substitute.Length);
    Array.Copy(print, 0, buffer, 16 + substitute.Length + 2, print.Length);
    return buffer;
  }
  static void AttributeAttack(string root, string outside) {
    byte[] set = Junction(outside);
    byte[] clear = new byte[8]; Array.Copy(BitConverter.GetBytes(0xA0000003U), clear, 4);
    using (var handle = CreateFileW(Path.Combine(root, "sub"), 0x100, 7, IntPtr.Zero, 3, 0x02000000 | 0x200000, IntPtr.Zero)) {
      if (handle.IsInvalid) { Interlocked.Increment(ref failures); return; }
      while (!stop) {
        Interlocked.Increment(ref attempts); uint returned;
        if (DeviceIoControl(handle, 0x900A4, set, (uint)set.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
          Interlocked.Increment(ref transitions);
        else Interlocked.Increment(ref failures);
        Thread.Yield();
        if (DeviceIoControl(handle, 0x900AC, clear, (uint)clear.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
          Interlocked.Increment(ref transitions);
        else Interlocked.Increment(ref failures);
      }
      uint ignored; DeviceIoControl(handle, 0x900AC, clear, (uint)clear.Length, IntPtr.Zero, 0, out ignored, IntPtr.Zero);
    }
  }
  public static string Run(string root, string outside, string manifest, string hash, string mode) {
    stop = false; attempts = transitions = failures = outsidePasses = calls = outsideReadOpens = 0;
    using (var outsideWatch = new OutsideReadWatch(Path.Combine(outside, "auth.json"))) {
    if (mode == "watch_control") {
      File.ReadAllBytes(Path.Combine(outside, "auth.json"));
      SpinWait.SpinUntil(() => Volatile.Read(ref outsideReadOpens) > 0, 2000);
      return "{\"outside_read_opens\":" + outsideReadOpens + "}";
    }
    Type oracle = null;
    foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
      oracle = assembly.GetType("BabelOwnedFileOracleV1"); if (oracle != null) break;
    }
    if (oracle == null) throw new InvalidOperationException();
    MethodInfo run = oracle.GetMethod("Run");
    if (mode == "watch_native_control") {
      object outcome = run.Invoke(null, new object[] { outside, manifest, hash });
      string json = (string)outcome.GetType().GetField("Json").GetValue(outcome);
      SpinWait.SpinUntil(() => Volatile.Read(ref outsideReadOpens) > 0, 2000);
      string reason;
      using (var document = System.Text.Json.JsonDocument.Parse(json)) reason = document.RootElement.GetProperty("reason_code").GetString();
      return "{\"oracle_passed\":" + (json.Contains("\"status\":\"passed\"", StringComparison.Ordinal) ? "true" : "false") +
        ",\"oracle_reason\":\"" + reason + "\",\"outside_read_opens\":" + Volatile.Read(ref outsideReadOpens) + "}";
    }
    if (mode == "hardlink") {
      object outcome = run.Invoke(null, new object[] { root, manifest, hash });
      string json = (string)outcome.GetType().GetField("Json").GetValue(outcome);
      SpinWait.SpinUntil(() => Volatile.Read(ref outsideReadOpens) > 0, 250);
      return "{\"oracle_refused\":" + (json.Contains("\"status\":\"unsupported\"", StringComparison.Ordinal) ? "true" : "false") +
        ",\"outside_read_opens\":" + Volatile.Read(ref outsideReadOpens) + "}";
    }
    var attack = new Thread(() => { if (mode == "attributes") AttributeAttack(root, outside); else MoveAttack(root); });
    attack.IsBackground = true; attack.Start();
    var startup = Stopwatch.StartNew();
    while (Volatile.Read(ref transitions) < 4 && startup.ElapsedMilliseconds < 2000) Thread.Sleep(1);
    try {
      var watch = Stopwatch.StartNew();
      while (watch.ElapsedMilliseconds < 1500 && calls < 5000) {
        object outcome = run.Invoke(null, new object[] { root, manifest, hash });
        string json = (string)outcome.GetType().GetField("Json").GetValue(outcome);
        calls++;
        if (json.Contains("\"status\":\"passed\"", StringComparison.Ordinal)) outsidePasses++;
      }
    } finally { stop = true; if (!attack.Join(3000)) throw new InvalidOperationException(); }
    return "{\"attempts\":" + attempts + ",\"transitions\":" + transitions + ",\"refusals\":" + failures +
      ",\"oracle_calls\":" + calls + ",\"outside_passes\":" + outsidePasses +
      ",\"outside_read_opens\":" + outsideReadOpens + "}";
    }
  }
}
'@
try {
  $references = [IO.Directory]::GetFiles((Join-Path $PSHOME 'ref'), '*.dll')
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $attackSource -ReferencedAssemblies $references -ErrorAction Stop
  [Console]::Out.WriteLine([BabelOwnedOracleRaceProbe]::Run($probeProjectRoot, $OutsideRoot, $probeManifestPath, $probeManifestHash, $Mode))
} catch {
  $codes = @([regex]::Matches([string]$_, '\bCS\d{4}\b') | ForEach-Object Value | Select-Object -Unique -First 4)
  [Console]::Out.WriteLine('{"probe_failed":true,"compiler_codes":"' + ($codes -join '_').ToLowerInvariant() + '"}')
  exit 2
}
