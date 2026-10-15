param([string]$ProjectRoot, [string]$ManifestPath, [string]$ManifestHash)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Owned Windows/NTFS data oracle. No profiles, policy bypass or project loading.
# The caller must pin this script/host closure and enforce a process deadline.
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class BabelOwnedFileOracleV1 {
  const uint ReadAttributes = 0x80, Synchronize = 0x100000, ReadData = 1;
  const uint OpenReparsePoint = 0x200000, SynchronousIo = 0x20, NoRecall = 0x400000;
  const uint DirectoryAttribute = 0x10, RefusedAttributes = 0x400 | 0x40 | 0x1000 | 0x40000 | 0x400000;
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  public sealed class Outcome { public int ExitCode; public string Json; }
  sealed class Refusal : Exception { public readonly string Code; public Refusal(string code) { Code = code; } }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes; public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder volume, uint volumeSize,
    out uint serial, out uint maxComponent, out uint flags, StringBuilder filesystem, uint filesystemSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadFile(SafeFileHandle handle, IntPtr buffer, uint length, out uint read, IntPtr overlapped);
  [DllImport("ntdll.dll")]
  static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes,
    out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition,
    uint options, IntPtr ea, uint eaLength);

  static Outcome Result(string state, string reason, string digest = null) {
    return new Outcome { ExitCode = state == "passed" ? 0 : state == "failed" ? 1 : 2,
      Json = "{\"schema_version\":1,\"status\":\"" + state + "\",\"reason_code\":\"" + reason + "\"" +
        (digest == null ? "" : ",\"candidate_sha256\":\"" + digest + "\"") + "}" };
  }
  static void Require(bool condition, string code) { if (!condition) throw new Refusal(code); }
  static bool Credential(string path) {
    string[] parts = path.Replace('/', '\\').ToLowerInvariant().Split('\\');
    string leaf = parts[parts.Length - 1];
    foreach (string part in parts) {
      if (part == "secrets" || part == ".codex" || part == ".ssh" || part == ".aws" ||
          part == ".azure" || part == ".git" || part == ".config" || part == ".gnupg" ||
          part == ".kube" || part == ".docker") return true;
    }
    return Regex.IsMatch(leaf, @"\A\.env(?:\.[a-z0-9_-]+)?\z") ||
      Regex.IsMatch(leaf, @"\.(?:pem|p12|pfx|key)\z") ||
      Regex.IsMatch(leaf, @"\Aid_(?:rsa|ed25519|dsa|ecdsa)\z") ||
      leaf == "credentials.json" || leaf == ".git-credentials" || leaf == ".npmrc";
  }
  static bool Device(string part) {
    return Regex.IsMatch(part, @"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\z)", RegexOptions.IgnoreCase);
  }
  static bool Candidate(string path) {
    if (String.IsNullOrEmpty(path) || path.Length > 512 || Credential(path)) return false;
    foreach (string part in path.Split('/'))
      if (part.Length > 128 || !Regex.IsMatch(part, @"\A[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?\z") || Device(part)) return false;
    return true;
  }
  static string[] RootParts(string input) {
    Require(input != null && input.Length <= 32768, "root_unsupported");
    string path = input.Replace('/', '\\');
    Require(Regex.IsMatch(path, @"\A[A-Za-z]:\\"), "root_unsupported");
    Require(!Credential(path), "root_unsupported");
    string tail = path.Substring(3);
    if (tail.EndsWith("\\", StringComparison.Ordinal)) tail = tail.Substring(0, tail.Length - 1);
    string[] parts = tail.Length == 0 ? new string[0] : tail.Split('\\');
    foreach (string part in parts) Require(part.Length > 0 && part.Length <= 255 && part != "." && part != ".." &&
      !part.EndsWith(".", StringComparison.Ordinal) && !part.EndsWith(" ", StringComparison.Ordinal) &&
      !part.Contains("~") && !Device(part) && !Regex.IsMatch(part, "[\\x00-\\x1f<>:\"/\\\\|?*]"), "root_unsupported");
    return parts;
  }
  static string FinalName(SafeFileHandle handle) {
    var name = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 1);
    Require(length > 0 && length < name.Capacity, "identity_unavailable");
    string value = name.ToString();
    Require(!Credential(value), "credential_path_refused");
    return value;
  }
  static FileInfo Metadata(SafeFileHandle handle, bool directory, uint? volume = null) {
    FileInfo info = default(FileInfo);
    Require(!handle.IsInvalid && GetFileType(handle) == 1 && GetFileInformationByHandle(handle, out info), "metadata_unavailable");
    Require((info.Attributes & RefusedAttributes) == 0 && ((info.Attributes & DirectoryAttribute) != 0) == directory,
      "filesystem_entry_unsupported");
    Require(!volume.HasValue || info.Volume == volume.Value, "volume_mismatch");
    FinalName(handle);
    return info;
  }
  static SafeFileHandle OpenComponent(SafeFileHandle parent, string component, bool data) {
    IntPtr text = Marshal.StringToHGlobalUni(component), unicode = IntPtr.Zero;
    try {
      var name = new UnicodeString { Length = checked((ushort)(component.Length * 2)),
        MaximumLength = checked((ushort)(component.Length * 2 + 2)), Buffer = text };
      unicode = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
      Marshal.StructureToPtr(name, unicode, false);
      var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
        RootDirectory = parent.DangerousGetHandle(), ObjectName = unicode, Attributes = 0x40 | 0x1000 };
      SafeFileHandle handle; IoStatus status;
      int code = NtCreateFile(out handle, ReadAttributes | Synchronize | (data ? ReadData : 0),
        ref attributes, out status, IntPtr.Zero, 0, 1, 1, OpenReparsePoint | SynchronousIo | NoRecall, IntPtr.Zero, 0);
      if (code != 0 || handle == null || handle.IsInvalid) {
        if (handle != null) handle.Dispose();
        throw new Refusal("rooted_open_refused");
      }
      return handle;
    } finally { if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
  }
  sealed class Root : IDisposable {
    readonly List<SafeFileHandle> chain = new List<SafeFileHandle>();
    public SafeFileHandle Directory; public uint Volume;
    public Root(string path) {
      try {
        string[] parts = RootParts(path);
        string drive = path.Substring(0, 2) + "\\";
        Require(GetDriveTypeW(drive) == 3, "filesystem_unsupported");
        var root = CreateFileW("\\\\?\\" + drive, ReadAttributes | Synchronize, 1, IntPtr.Zero, 3,
          0x02000000 | OpenReparsePoint, IntPtr.Zero);
        chain.Add(root);
        var rootInfo = Metadata(root, true);
        Require(Regex.IsMatch(FinalName(root), @"\A\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\\z"), "root_alias_unsupported");
        var filesystem = new StringBuilder(64);
        uint serial, maxComponent, flags;
        Require(GetVolumeInformationByHandleW(root, null, 0, out serial, out maxComponent, out flags,
          filesystem, (uint)filesystem.Capacity) && filesystem.ToString() == "NTFS", "filesystem_unsupported");
        Volume = rootInfo.Volume; Directory = root;
        foreach (string part in parts) {
          var next = OpenComponent(Directory, part, false);
          chain.Add(next); Metadata(next, true, Volume); Directory = next;
        }
      } catch { Dispose(); throw; }
    }
    public byte[] Read(string relative, int cap) {
      Require(Candidate(relative), "candidate_path_unsupported");
      SafeFileHandle parent = Directory;
      string[] parts = relative.Split('/');
      foreach (string part in parts.AsSpan(0, parts.Length - 1)) {
        var next = OpenComponent(parent, part, false);
        chain.Add(next); Metadata(next, true, Volume); parent = next;
      }
      var leaf = OpenComponent(parent, parts[parts.Length - 1], true);
      chain.Add(leaf);
      var before = Metadata(leaf, false, Volume);
      ulong size = ((ulong)before.SizeHigh << 32) | before.SizeLow;
      Require(before.Links == 1 && size <= (ulong)cap, "candidate_unsupported");
      byte[] buffer = new byte[(int)size + 1]; int length = 0;
      GCHandle pin = GCHandle.Alloc(buffer, GCHandleType.Pinned);
      try {
        while (length < buffer.Length) {
          uint count;
          Require(ReadFile(leaf, IntPtr.Add(pin.AddrOfPinnedObject(), length), (uint)(buffer.Length - length),
            out count, IntPtr.Zero), "read_unavailable");
          if (count == 0) break;
          Require(count <= buffer.Length - length, "read_inconsistent");
          length += (int)count;
        }
      } finally { pin.Free(); }
      var after = Metadata(leaf, false, Volume);
      Require(length == (int)size && before.Attributes == after.Attributes && before.Links == after.Links &&
        before.Volume == after.Volume && before.IndexHigh == after.IndexHigh && before.IndexLow == after.IndexLow &&
        before.SizeHigh == after.SizeHigh && before.SizeLow == after.SizeLow &&
        before.Write.High == after.Write.High && before.Write.Low == after.Write.Low &&
        before.Creation.High == after.Creation.High && before.Creation.Low == after.Creation.Low, "read_inconsistent");
      Array.Resize(ref buffer, length);
      return buffer;
    }
    public void Dispose() { for (int i = chain.Count - 1; i >= 0; i--) chain[i].Dispose(); chain.Clear(); }
  }
  public static Outcome Run(string projectRoot, string manifestPath, string manifestHash) {
    try {
      Require(IntPtr.Size == 8 && Marshal.SizeOf<UnicodeString>() == 16 && Marshal.SizeOf<ObjectAttributes>() == 48 &&
        Marshal.SizeOf<IoStatus>() == 16 && Marshal.SizeOf<FileInfo>() == 52, "native_layout_unsupported");
      RootParts(projectRoot);
      Require(manifestHash != null && Regex.IsMatch(manifestHash, @"\A[0-9a-f]{64}\z"), "manifest_invalid");
      string[] manifestParts = RootParts(manifestPath);
      Require(manifestParts.Length > 0 && manifestParts[manifestParts.Length - 1] ==
        "owned-file-assertion-" + manifestHash + ".json", "manifest_invalid");
      string normalized = manifestPath.Replace('/', '\\');
      string manifestDirectory = normalized.Substring(0, normalized.LastIndexOf('\\'));
      if (manifestDirectory.Length == 2) manifestDirectory += "\\";
      byte[] bytes;
      using (var owner = new Root(manifestDirectory)) bytes = owner.Read(manifestParts[manifestParts.Length - 1], 256 * 1024);
      Require(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() == manifestHash, "manifest_hash_mismatch");
      using (var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 })) {
        var item = document.RootElement;
        Require(item.ValueKind == JsonValueKind.Object, "manifest_invalid");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in item.EnumerateObject()) Require(names.Add(property.Name) &&
          (property.Name == "schema_version" || property.Name == "kind" || property.Name == "candidate_path" ||
            property.Name == "operation" || property.Name == "expected"), "manifest_invalid");
        Require(names.Count == 5 && item.GetProperty("schema_version").GetInt32() == 1 &&
          item.GetProperty("kind").GetString() == "owned_file_assertion_v1" &&
          item.GetProperty("operation").GetString() == "utf8_equals", "manifest_invalid");
        string path = item.GetProperty("candidate_path").GetString(), expected = item.GetProperty("expected").GetString();
        Require(Candidate(path) && expected != null, "manifest_invalid");
        byte[] literal = Utf8.GetBytes(expected);
        Require(literal.Length <= 32768, "manifest_invalid");
        byte[] content;
        using (var owner = new Root(projectRoot)) content = owner.Read(path, 1024 * 1024);
        try { Utf8.GetString(content); } catch { return Result("unsupported", "candidate_not_utf8"); }
        bool matched = content.AsSpan().SequenceEqual(literal);
        return Result(matched ? "passed" : "failed", matched ? "literal_matched" : "literal_mismatch",
          Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant());
      }
    } catch (Refusal refusal) { return Result("unsupported", refusal.Code); }
      catch { return Result("unsupported", "native_oracle_unavailable"); }
  }
}
'@

try {
  if (-not $IsWindows -or [IntPtr]::Size -ne 8 -or $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'NATIVE_BOUNDARY_UNAVAILABLE'
  }
  Microsoft.PowerShell.Core\Import-Module -Name (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  $references = [IO.Directory]::GetFiles((Join-Path $PSHOME 'ref'), '*.dll')
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies $references -ErrorAction Stop
  if ($MyInvocation.InvocationName -ne '.') {
    $outcome = [BabelOwnedFileOracleV1]::Run($ProjectRoot, $ManifestPath, $ManifestHash)
    [Console]::Out.WriteLine($outcome.Json)
    exit $outcome.ExitCode
  }
} catch {
  $reason = 'native_boundary_unavailable'
  $codes = @([regex]::Matches([string]$_, '\bCS\d{4}\b') | ForEach-Object Value | Select-Object -Unique -First 4)
  if ($codes.Count -gt 0) { $reason = 'native_compile_' + ($codes -join '_').ToLowerInvariant() }
  [Console]::Out.WriteLine('{"schema_version":1,"status":"unsupported","reason_code":"' + $reason + '"}')
  exit 2
}
