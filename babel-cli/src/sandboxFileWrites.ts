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
    writeFileSync(fd, content, 'utf-8');
    if (options?.createOnly) {
      // Windows may finalize file identity metadata during the write.
      const stat = fstatSync(fd, { bigint: true });
      options.onCreated?.({ path: targetPath, device: stat.dev.toString(), inode: stat.ino.toString() });
    }
  } finally {
    closeSync(fd);
  }
}
