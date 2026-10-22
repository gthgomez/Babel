import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'

import {
  __testPinWindowsDirectories,
  __testResetChildProcessSpawn,
  __testResetWindowsAcquireTimeoutMs,
  __testSetChildProcessSpawn,
  __testSetWindowsAcquireTimeoutMs,
  __testWindowsReadyLineForBoundDirectories,
} from './effectDirectoryAnchors.js'

function fixtureBoundDirectory(prefix: string): string {
  return resolve(mkdtempSync(join(tmpdir(), prefix)))
}

function mockHelperChild(write: (stdout: PassThrough) => void, options?: { delayedExitMs?: number }): ChildProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ChildProcess
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  let killed = false
  child.kill = () => {
    if (!killed) {
      killed = true
      const delay = options?.delayedExitMs ?? 0
      setTimeout(() => { child.emit('exit', 0) }, delay)
    }
    return true
  }
  write(stdout)
  return child
}

function mockLineChild(lines: string[], options?: { delayedExitMs?: number }): ChildProcess {
  return mockHelperChild(stdout => {
    for (const line of lines) stdout.write(`${line}\n`)
  }, options)
}

function mockChunkChild(chunks: string[]): ChildProcess {
  return mockHelperChild(stdout => {
    for (const chunk of chunks) stdout.write(chunk)
  })
}

describe('Windows helper diagnostic protocol (STAGE introduced by this patch)', () => {
  test('line parser accepts transcript fragmented within STAGE and READY tokens', async () => {
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-frag-')
    const readyLine = __testWindowsReadyLineForBoundDirectories([bound])
    const readyPrefix = readyLine.slice(0, readyLine.length - 1)
    const readySuffix = readyLine.slice(-1)
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockChunkChild([
      'STAGE:bo',
      'ot\nSTAGE:ty',
      'ped\nSTAGE:op',
      'en\n',
      readyPrefix,
      `${readySuffix}\n`,
    ]) as ReturnType<typeof spawn>) as typeof spawn)

    const anchors = await __testPinWindowsDirectories([bound])
    const file = join(bound, 'file.txt')
    assert.equal(anchors.path(file), file)
    await anchors.release()
    await __testResetChildProcessSpawn()
  })

  test('fail-closed when helper stdout exceeds UTF-8 byte bound', async () => {
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-bound-')
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockHelperChild(stdout => {
      stdout.write(`${'X'.repeat(1025)}\n`)
    }) as ReturnType<typeof spawn>) as typeof spawn)

    await assert.rejects(
      () => __testPinWindowsDirectories([bound]),
      /exceeded 1024-byte bound/,
    )
    await __testResetChildProcessSpawn()
  })

  test('rejects garbage, malformed STAGE, and wrong READY count before a later valid READY', async () => {
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-negative-')
    const readyLine = __testWindowsReadyLineForBoundDirectories([bound])
    const wrongReady = readyLine.replace(/\d+$/, '1')
    const cases = [
      ['STAGE:boot', 'STAGE:typed', 'STAGE:open', 'GARBAGE', readyLine],
      ['STAGE:boot', 'STAGE:evil', 'STAGE:open', readyLine],
      ['STAGE:boot', 'STAGE:typed', 'STAGE:open', wrongReady, readyLine],
    ]
    for (const lines of cases) {
      __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockLineChild(lines) as ReturnType<typeof spawn>) as typeof spawn)
      await assert.rejects(() => __testPinWindowsDirectories([bound]), /refused/)
    }
    await __testResetChildProcessSpawn()
  })

  test('rejects ERROR or garbage trailing READY in the same stdout chunk', async () => {
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-trailing-')
    const readyLine = __testWindowsReadyLineForBoundDirectories([bound])
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockChunkChild([
      `STAGE:boot\nSTAGE:typed\nSTAGE:open\n${readyLine}\nERROR:1:5\n`,
    ]) as ReturnType<typeof spawn>) as typeof spawn)
    await assert.rejects(() => __testPinWindowsDirectories([bound]), /refused/)

    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockChunkChild([
      `STAGE:boot\nSTAGE:typed\nSTAGE:open\n${readyLine}\nGARBAGE\n`,
    ]) as ReturnType<typeof spawn>) as typeof spawn)
    await assert.rejects(() => __testPinWindowsDirectories([bound]), /refused/)
    await __testResetChildProcessSpawn()
  })

  test('rejects unterminated trailing bytes after READY without a final newline', async () => {
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-suffix-')
    const readyLine = __testWindowsReadyLineForBoundDirectories([bound])
    const prefix = `STAGE:boot\nSTAGE:typed\nSTAGE:open\n${readyLine}\n`
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockChunkChild([
      `${prefix}ERROR:1:5`,
    ]) as ReturnType<typeof spawn>) as typeof spawn)
    await assert.rejects(() => __testPinWindowsDirectories([bound]), /refused/)

    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockChunkChild([
      `${prefix}GARBAGE`,
    ]) as ReturnType<typeof spawn>) as typeof spawn)
    await assert.rejects(() => __testPinWindowsDirectories([bound]), /refused/)
    await __testResetChildProcessSpawn()
  })

  test('timeout reports explicit startup stage when no STAGE line arrived', async () => {
    __testSetWindowsAcquireTimeoutMs(40)
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-timeout-')
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockHelperChild(() => {
      /* no stdout */
    }) as ReturnType<typeof spawn>) as typeof spawn)

    await assert.rejects(
      () => __testPinWindowsDirectories([bound]),
      /timed out \(last stage: startup\)/,
    )
    await __testResetChildProcessSpawn()
    __testResetWindowsAcquireTimeoutMs()
  })

  test('timeout cleanup kills helper and allows a subsequent acquisition', async () => {
    __testSetWindowsAcquireTimeoutMs(40)
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-cleanup-')
    let spawns = 0
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => {
      spawns += 1
      if (spawns === 1) return mockHelperChild(() => undefined) as ReturnType<typeof spawn>
      const readyLine = __testWindowsReadyLineForBoundDirectories([bound])
      return mockLineChild(['STAGE:boot', 'STAGE:typed', 'STAGE:open', readyLine]) as ReturnType<typeof spawn>
    }) as typeof spawn)

    await assert.rejects(() => __testPinWindowsDirectories([bound]), /timed out/)
    const anchors = await __testPinWindowsDirectories([bound])
    await anchors.release()
    assert.equal(spawns, 2)
    await __testResetChildProcessSpawn()
    __testResetWindowsAcquireTimeoutMs()
  })
})

describe('Windows anchor ownership without process-global gate', () => {
  test('independent simultaneous owners each retain their helper until release', async () => {
    await __testResetChildProcessSpawn()
    const leftBound = fixtureBoundDirectory('babel-anchor-left-')
    const rightBound = fixtureBoundDirectory('babel-anchor-right-')
    const leftReady = __testWindowsReadyLineForBoundDirectories([leftBound])
    const rightReady = __testWindowsReadyLineForBoundDirectories([rightBound])
    let spawns = 0
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => {
      spawns += 1
      const readyLine = spawns === 1 ? leftReady : rightReady
      return mockLineChild(['STAGE:boot', 'STAGE:typed', 'STAGE:open', readyLine]) as ReturnType<typeof spawn>
    }) as typeof spawn)

    const leftPromise = __testPinWindowsDirectories([leftBound])
    const rightPromise = __testPinWindowsDirectories([rightBound])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(spawns, 2, 'parallel admissions must not wait on a global gate')
    const [left, right] = await Promise.all([leftPromise, rightPromise])
    assert.equal(left.path(join(leftBound, 'a.txt')), join(leftBound, 'a.txt'))
    assert.equal(right.path(join(rightBound, 'b.txt')), join(rightBound, 'b.txt'))
    await Promise.all([left.release(), right.release()])
    await __testResetChildProcessSpawn()
  })

  test('sequential release calls are idempotent and each await helper exit', async () => {
    await __testResetChildProcessSpawn()
    const bound = fixtureBoundDirectory('babel-anchor-idempotent-')
    const readyLine = __testWindowsReadyLineForBoundDirectories([bound])
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockLineChild([
      'STAGE:boot', 'STAGE:typed', 'STAGE:open', readyLine,
    ], { delayedExitMs: 40 }) as ReturnType<typeof spawn>) as typeof spawn)

    const anchors = await __testPinWindowsDirectories([bound])
    const first = anchors.release()
    const second = anchors.release()
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(secondSettled, false, 'concurrent release must stay pending until helper exit')
    await Promise.all([first, second])
    await anchors.release()
    await __testResetChildProcessSpawn()
  })
})
