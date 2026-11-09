import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  writeFileSync,
} from 'node:fs';

export interface TrustedFileCreationEvidence {
  path: string;
  device: string;
  inode: string;
  /**
   * Create-only settlement failed before the host confirmed full intended bytes.
   * Only path/device/inode are attested; byte content is not captured (fail closed).
   */
  settlementIncomplete?: true;
  /** Bounded recovery hint: file size observed on the open fd at failure time. */
  unsettledSizeBytes?: number;
}

type WriteUtf8ToFd = (fd: number, content: string) => void;

const TEST_SOURCE_EXTENSIONS = new Set([
  '.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.py', '.rb', '.rs', '.tsx', '.ts',
]);
const PRIVATE_TEST_PATH_SEGMENTS = new Set([
  'artifacts', 'build', 'certs', 'coverage', 'credentials', 'keys', 'node_modules',
  'private', 'runs', 'secret', 'secrets', 'vendor',
]);
const PRIVATE_TEST_BASENAME = /(?:^|[._-])(?:api[_-]?keys?|credentials?|id_rsa|id_ed25519|passwords?|private|secrets?|tokens?)(?:[._-]|$)/i;

/**
 * Only fresh, conventionally named test source is shared with the test runner.
 * Parent directory permissions are never changed; they must already permit
 * container traversal or the test runner fails closed.
 */
export function isSandboxReadableTestPath(inputPath: string): boolean {
  const segments = inputPath.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) =>
    segment === '..' || segment.startsWith('.') || PRIVATE_TEST_PATH_SEGMENTS.has(segment.toLowerCase()) ||
    PRIVATE_TEST_BASENAME.test(segment)
  )) return false;
  const basename = segments.at(-1)!;
  const extension = basename.slice(basename.lastIndexOf('.')).toLowerCase();
  return TEST_SOURCE_EXTENSIONS.has(extension) && /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(basename) && !PRIVATE_TEST_BASENAME.test(basename);
}

let writeUtf8ToFd: WriteUtf8ToFd = (fd, content) => {
  writeFileSync(fd, content, 'utf-8');
};

/** Test-only seam for real truncated-write fault injection without weakening production guards. */
export function __testOnlySetWriteUtf8ToFd(implementation: WriteUtf8ToFd | null): void {
  writeUtf8ToFd = implementation ?? ((fd, content) => writeFileSync(fd, content, 'utf-8'));
}

type PartialAttestHook = (context: { fd: number; targetPath: string }) => void;
let beforePartialAttest: PartialAttestHook | null = null;

/** Test-only: run synchronously after a failed create-only write, before incomplete attestation. */
export function __testOnlyBeforePartialAttest(hook: PartialAttestHook | null): void {
  beforePartialAttest = hook;
}

function attestIncompleteCreate(
  fd: number,
  targetPath: string,
  onCreated?: (evidence: TrustedFileCreationEvidence) => void,
): void {
  if (!onCreated) return;
  try {
    beforePartialAttest?.({ fd, targetPath });
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return;
    onCreated({
      path: targetPath,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      settlementIncomplete: true,
      unsettledSizeBytes: Number(stat.size),
    });
  } catch {
    // Partial settlement may lack trustworthy identity; fail closed for ownership.
  } finally {
    beforePartialAttest = null;
  }
}

export function writeUtf8FileSafely(
  inputPath: string,
  targetPath: string,
  content: string,
  enforceProjectRoot: boolean,
  assertSafeTarget: (inputPath: string, targetPath: string, enforceProjectRoot: boolean) => void,
  options?: { createOnly?: true; sandboxReadableTest?: true; onCreated?: (evidence: TrustedFileCreationEvidence) => void },
): void {
  assertSafeTarget(inputPath, targetPath, enforceProjectRoot);

  const noFollowFlag = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const createFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const truncateFlags = fsConstants.O_WRONLY | fsConstants.O_TRUNC;
  const originalFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT |
    (options?.createOnly ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
  let fd: number;
  let created = false;
  if (options?.sandboxReadableTest) {
    try {
      fd = openSync(targetPath, createFlags | noFollowFlag, 0o666);
      created = true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (noFollowFlag !== 0 && (code === 'EINVAL' || code === 'UNKNOWN' || code === 'ENOSYS')) {
        try {
          fd = openSync(targetPath, createFlags, 0o666);
          created = true;
        } catch (createError: unknown) {
          if (options?.createOnly || (createError as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw createError;
          fd = openSync(targetPath, truncateFlags, 0o666);
        }
      } else {
        if (options?.createOnly || code !== 'EEXIST') throw error;
        // Existing modes are user-controlled. Reopen without O_CREAT so a race
        // that removes the target fails instead of creating it under a new mode.
        fd = openSync(targetPath, truncateFlags | noFollowFlag, 0o666);
      }
    }
  } else {
    // Keep the established writer behavior for all ordinary writes and platforms.
    try {
      fd = openSync(targetPath, originalFlags | noFollowFlag, 0o666);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (noFollowFlag !== 0 && (code === 'EINVAL' || code === 'UNKNOWN' || code === 'ENOSYS')) {
        fd = openSync(targetPath, originalFlags, 0o666);
      } else {
        throw error;
      }
    }
  }

  try {
    assertSafeTarget(inputPath, targetPath, enforceProjectRoot);
    try {
      writeUtf8ToFd(fd, content);
      if (created && options?.sandboxReadableTest && process.platform !== 'win32') {
        // Recheck containment and bind the chmod to the newly-created inode.
        // Existing files retain their original mode.
        assertSafeTarget(inputPath, targetPath, enforceProjectRoot);
        const descriptorStat = fstatSync(fd, { bigint: true });
        const pathStat = lstatSync(targetPath, { bigint: true });
        if (!pathStat.isFile() || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
          throw new Error('[sandbox] New test source changed during permission setup.');
        }
        // Apply before publishing create-only ownership evidence.
        fchmodSync(fd, 0o644);
      }
    } catch (writeError) {
      if (options?.createOnly) {
        attestIncompleteCreate(fd, targetPath, options.onCreated);
      }
      throw writeError;
    }
    if (options?.createOnly) {
      // Windows may finalize file identity metadata during the write.
      const stat = fstatSync(fd, { bigint: true });
      options.onCreated?.({ path: targetPath, device: stat.dev.toString(), inode: stat.ino.toString() });
    }
  } finally {
    closeSync(fd);
  }
}
