import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WINDOWS_ACL_VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $path = $env:BABEL_ADMISSION_ACL_PATH',
  '  $isDirectory = $env:BABEL_ADMISSION_ACL_DIRECTORY -eq \'1\'',
  '  $sid = $env:BABEL_ADMISSION_USER_SID',
  '  $sections = [System.Security.AccessControl.AccessControlSections]::Access',
  '  if ($isDirectory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new($path, $sections) } else { $acl = [System.Security.AccessControl.FileSecurity]::new($path, $sections) }',
  '  $rules = @($acl.Access)',
  "  if (-not $acl.AreAccessRulesProtected) { [Console]::Out.Write('acl_check_not_protected'); exit 1 }",
  "  if ($rules.Count -ne 1) { [Console]::Out.Write('acl_check_rule_count_many'); exit 1 }",
  '  $actual = $rules[0]',
  "  if ($actual.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { [Console]::Out.Write('acl_check_owner_sid'); exit 1 }",
  "  if ($actual.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $actual.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { [Console]::Out.Write('acl_check_allow_full_control'); exit 1 }",
  "  if ($actual.IsInherited -or $actual.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { [Console]::Out.Write('acl_check_inheritance_or_propagation'); exit 1 }",
  "  if ($isDirectory -and ($actual.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit))) { [Console]::Out.Write('acl_check_directory_inheritance'); exit 1 }",
  "  if (-not $isDirectory -and $actual.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) { [Console]::Out.Write('acl_check_file_inheritance'); exit 1 }",
  '  exit 0',
  "} catch { [Console]::Out.Write('acl_check_exception'); exit 1 }",
].join('; ');

const WINDOWS_STANDARD_ACL_SIDS = [
  'S-1-1-0', 'S-1-5-4', 'S-1-5-6', 'S-1-5-7', 'S-1-5-11', 'S-1-5-18',
  'S-1-5-19', 'S-1-5-20', 'S-1-5-32-544', 'S-1-5-32-545', 'S-1-5-32-546',
  'S-1-3-0', 'S-1-3-1',
];

let windowsUserSid: string | undefined;

/** Apply and verify an owner-only NTFS DACL using trusted System32 tools. */
export function enforceOwnerOnlyWindowsAcl(path: string, directory: boolean): { ok: boolean; code: string } {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) return { ok: false, code: 'missing_system_root' };
  const system32 = join(systemRoot, 'System32');
  const safeEnvironment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    Path: process.env.Path ?? process.env.PATH,
    PSModulePath: join(system32, 'WindowsPowerShell', 'v1.0', 'Modules'),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  if (!windowsUserSid) {
    const identity = spawnSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', env: safeEnvironment, timeout: 5_000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sid = identity.stdout?.match(/S-\d-(?:\d+-)*\d+/g)?.at(-1);
    if (identity.status !== 0 || !sid) {
      const identityError = identity.error as NodeJS.ErrnoException | undefined;
      const code = identityError?.code === 'ETIMEDOUT' ? 'acl_identity_timeout' : identityError?.code ?? 'identity_unavailable';
      return { ok: false, code };
    }
    windowsUserSid = sid;
  }

  const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const icaclsPath = join(system32, 'icacls.exe');
  const grant = `*${windowsUserSid}:${directory ? '(OI)(CI)F' : 'F'}`;
  const ruleEntries = [...new Set([...WINDOWS_STANDARD_ACL_SIDS, windowsUserSid])].map((sid) => `*${sid}`);
  const apply = spawnSync(icaclsPath, [path, '/inheritance:r', '/remove:g', ...ruleEntries, '/remove:d', ...ruleEntries, '/grant:r', grant, '/Q'], {
    encoding: 'utf8', env: safeEnvironment, timeout: 5_000, windowsHide: true, stdio: 'ignore',
  });
  if (apply.status !== 0) {
    const applyError = apply.error as NodeJS.ErrnoException | undefined;
    const code = applyError?.code === 'ETIMEDOUT' ? 'acl_apply_timeout' : applyError?.code ?? 'acl_apply_failed';
    return { ok: false, code };
  }
  const verifyArgs = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_VERIFY_SCRIPT];
  const verifyEnv = {
    ...safeEnvironment,
    BABEL_ADMISSION_ACL_PATH: path,
    BABEL_ADMISSION_ACL_DIRECTORY: directory ? '1' : '0',
    BABEL_ADMISSION_USER_SID: windowsUserSid,
  };
  let lastCode = 'acl_verification_failed';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(powershell, verifyArgs, {
      encoding: 'utf8', env: verifyEnv, timeout: attempt === 0 ? 10_000 : 20_000,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) return { ok: true, code: 'ok' };
    const diagnostic = result.stdout?.trim();
    const safeDiagnostic = diagnostic && /^acl_check_[a-z0-9_]+$/.test(diagnostic) ? diagnostic : null;
    const verificationError = result.error as NodeJS.ErrnoException | undefined;
    lastCode = verificationError?.code === 'ETIMEDOUT'
      ? 'acl_verification_timeout'
      : verificationError?.code ?? (safeDiagnostic ? `acl_verification_failed:${safeDiagnostic}` : 'acl_verification_failed');
    if (lastCode !== 'acl_verification_timeout') break;
  }
  return { ok: false, code: lastCode };
}
