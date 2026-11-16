# Babel-owned Windows Credential Manager bridge. Input/output are private pipes;
# credentials are never written to arguments, environment variables, or files.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw 'Invalid reference.' }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class BabelLocalCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public UInt32 Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
  private const UInt32 Generic = 1, LocalMachine = 2;
  private const int NotFound = 1168;
  private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
  private static string Target(string id) { return "Babel/" + id; }
  public static string Get(string id) {
    IntPtr ptr;
    if (!CredRead(Target(id), Generic, 0, out ptr)) {
      if (Marshal.GetLastWin32Error() == NotFound) return null;
      throw new InvalidOperationException();
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (c.Type != Generic || c.Persist != LocalMachine || c.CredentialBlobSize > 4096) throw new InvalidOperationException();
      byte[] bytes = new byte[c.CredentialBlobSize];
      try { Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length); return Utf8.GetString(bytes); }
      finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(ptr); }
  }
  public static void Set(string id, string value) {
    if (Get(id) != null) throw new InvalidOperationException();
    byte[] bytes = Utf8.GetBytes(value);
    if (bytes.Length == 0 || bytes.Length > 4096) throw new InvalidOperationException();
    IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, ptr, bytes.Length);
      CREDENTIAL c = new CREDENTIAL { Type=Generic, TargetName=Target(id), UserName="Babel", Persist=LocalMachine, CredentialBlobSize=(UInt32)bytes.Length, CredentialBlob=ptr };
      if (!CredWrite(ref c, 0)) throw new InvalidOperationException();
    } finally {
      Array.Clear(bytes, 0, bytes.Length);
      for (int i=0; i<bytes.Length; i++) Marshal.WriteByte(ptr, i, 0);
      Marshal.FreeHGlobal(ptr);
    }
  }
  public static bool Remove(string id) {
    if (Get(id) == null) return false;
    if (CredDelete(Target(id), Generic, 0)) return true;
    if (Marshal.GetLastWin32Error() == NotFound) return false;
    throw new InvalidOperationException();
  }
}
'@
  switch -CaseSensitive ($request.operation) {
    'selftest' { $result = $true }
    'get' { $result = [BabelLocalCredential]::Get($request.id) }
    'set' { if ($request.value -isnot [string]) { throw 'Invalid input.' }; [BabelLocalCredential]::Set($request.id, $request.value); $result = $true }
    'remove' { $result = [BabelLocalCredential]::Remove($request.id) }
    default { throw 'Invalid operation.' }
  }
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ok=$true; result=$result}))
} catch {
  # Self-test input contains no secret and never calls a credential API.
  if ($null -ne $request -and $request.operation -ceq 'selftest') { [Console]::Error.WriteLine($_.Exception.Message) }
  [Console]::Out.Write('{"ok":false,"result":null}')
  exit 1
}
