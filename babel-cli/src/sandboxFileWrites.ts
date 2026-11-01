import {
  closeSync,
  constants as fsConstants,
  fstatSync,
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
  options?: { createOnly?: true; onCreated?: (evidence: TrustedFileCreationEvidence) => void },
): void {
  assertSafeTarget(inputPath, targetPath, enforceProjectRoot);

  const noFollowFlag = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const baseFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT |
    (options?.createOnly ? fsConstants.O_EXCL : fsConstants.O_TRUNC);

  let fd: number;
  try {
    fd = openSync(targetPath, baseFlags | noFollowFlag, 0o666);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (noFollowFlag !== 0 && (code === 'EINVAL' || code === 'UNKNOWN' || code === 'ENOSYS')) {
      fd = openSync(targetPath, baseFlags, 0o666);
    } else {
      throw error;
    }
  }

  try {
    assertSafeTarget(inputPath, targetPath, enforceProjectRoot);
    try {
      writeUtf8ToFd(fd, content);
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
