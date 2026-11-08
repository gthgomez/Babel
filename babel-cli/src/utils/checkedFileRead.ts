import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'

function sameFileIdentity(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && a.nlink === 1 && b.nlink === 1 &&
    a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

/** Read only the checked regular file, with a bounded allocation and identity revalidation. */
export function checkedFileBytes(path: string, maxBytes: number, validatePath: () => boolean, expected?: Stats, expectedExact?: { dev: bigint; ino: bigint }): Buffer | null {
  let fd: number | undefined
  try {
    const exactBefore = lstatSync(path, { bigint: true })
    const before = lstatSync(path)
    if (!exactBefore.isFile() || exactBefore.isSymbolicLink() || exactBefore.nlink !== 1n || exactBefore.ino <= 0n ||
        !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes ||
        before.dev !== Number(exactBefore.dev) || before.ino !== Number(exactBefore.ino) || (expected && !sameFileIdentity(expected, before))) return null
    if (expectedExact && (exactBefore.dev !== expectedExact.dev || exactBefore.ino !== expectedExact.ino)) return null
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const exactOpened = fstatSync(fd, { bigint: true })
    if (exactBefore.dev !== exactOpened.dev || exactBefore.ino !== exactOpened.ino || !sameFileIdentity(before, opened) || !validatePath() || !sameFileIdentity(opened, lstatSync(path))) return null
    const exactNamed = lstatSync(path, { bigint: true })
    if (exactOpened.dev !== exactNamed.dev || exactOpened.ino !== exactNamed.ino) return null
    const bytes = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length !== opened.size || !sameFileIdentity(opened, fstatSync(fd))) return null
    return bytes.subarray(0, length)
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}
