import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'

import {
  __testPinWindowsDirectories,
  __testResetChildProcessSpawn,
  __testResetWindowsAcquireTimeoutMs,
  __testSetChildProcessSpawn,
  __testSetWindowsAcquireTimeoutMs,
} from './effectDirectoryAnchors.js'

/** Pre-fix stdout policy: trim-equals READY or refuse on any newline before a match. */
function legacyReadyOutcome(output: string, readyLine: string): 'ready' | 'refused' | 'pending' {
  if (output.trim() === readyLine) return 'ready'
  if (output.includes('\n') || output.length > 1024) return 'refused'
  return 'pending'
}

function mockHelperChild(lines: string[], deferOutput = false): ChildProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as ChildProcess
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.kill = () => {
    setImmediate(() => { child.emit('exit', 0) })
    return true
  }

  const writeLines = (): void => {
    for (const line of lines) stdout.write(`${line}\n`)
  }
  if (deferOutput) setImmediate(writeLines)
  else writeLines()
  return child
}

describe('1. demonstrated line-framing correctness defect', () => {
  test('legacy trim-based parser refuses multi-line stdout before READY', () => {
    const readyLine = 'READY:3'
    const helperStdout = 'STAGE:boot\nSTAGE:typed\nSTAGE:open\nREADY:3\n'
    assert.equal(legacyReadyOutcome(helperStdout, readyLine), 'refused')
  })

  test('line-framed parser accepts the same helper transcript', async () => {
    await __testResetChildProcessSpawn()
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockHelperChild([
      'STAGE:boot',
      'STAGE:typed',
      'STAGE:open',
      'READY:3',
    ]) as ReturnType<typeof spawn>) as typeof spawn)

    const anchors = await __testPinWindowsDirectories(['/tmp/babel-ready-line'])
    assert.equal(anchors.path('/tmp/babel-ready-line/file.txt'), '/tmp/babel-ready-line/file.txt')
    await anchors.release()
    await __testResetChildProcessSpawn()
  })
})

describe('2. diagnostic improvement (not Windows root-cause reproduction)', () => {
  test('timeout errors retain the last STAGE marker from helper stdout', async () => {
    // Shortened deadline for Linux CI only; does not model Windows Add-Type latency.
    __testSetWindowsAcquireTimeoutMs(40)
    await __testResetChildProcessSpawn()
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => mockHelperChild([
      'STAGE:boot',
      'STAGE:typed',
    ]) as ReturnType<typeof spawn>) as typeof spawn)

    await assert.rejects(
      () => __testPinWindowsDirectories(['/tmp/babel-timeout']),
      /Windows handle acquisition timed out.*last stage: typed/,
    )
    await __testResetChildProcessSpawn()
    __testResetWindowsAcquireTimeoutMs()
  })
})

describe('3. unproven contention mitigation (candidate; needs Windows CI)', () => {
  test('process-wide pin lock serializes overlapping acquisitions on one Node process', async () => {
    await __testResetChildProcessSpawn()
    let active = 0
    let maxActive = 0
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const child = mockHelperChild(['STAGE:boot', 'STAGE:typed', 'STAGE:open', 'READY:3'])
      child.once('exit', () => { active -= 1 })
      return child as ReturnType<typeof spawn>
    }) as typeof spawn)

    const first = await __testPinWindowsDirectories(['/tmp/babel-serial-a'])
    let secondStarted = false
    const second = __testPinWindowsDirectories(['/tmp/babel-serial-b']).then(async anchors => {
      secondStarted = true
      await anchors.release()
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(secondStarted, false, 'lock holds until the first anchor is released')
    await first.release()
    await second
    assert.equal(maxActive, 1, 'mitigation hypothesis: one in-flight helper per process')
    await __testResetChildProcessSpawn()
  })
})

describe('concurrent acquisition regression (production pin path)', () => {
  test('parallel callers each complete acquire and release without cross-talk', async () => {
    await __testResetChildProcessSpawn()
    const spawnIds: string[] = []
    __testSetChildProcessSpawn(((..._args: Parameters<typeof spawn>) => {
      const id = `helper-${spawnIds.length + 1}`
      spawnIds.push(id)
      return mockHelperChild(['STAGE:boot', 'STAGE:typed', 'STAGE:open', 'READY:3']) as ReturnType<typeof spawn>
    }) as typeof spawn)

    const [leftPath, rightPath] = await Promise.all([
      (async () => {
        const anchors = await __testPinWindowsDirectories(['/tmp/babel-concurrent-left'])
        const path = anchors.path('/tmp/babel-concurrent-left/file.txt')
        await anchors.release()
        return path
      })(),
      (async () => {
        const anchors = await __testPinWindowsDirectories(['/tmp/babel-concurrent-right'])
        const path = anchors.path('/tmp/babel-concurrent-right/file.txt')
        await anchors.release()
        return path
      })(),
    ])
    assert.equal(leftPath, '/tmp/babel-concurrent-left/file.txt')
    assert.equal(rightPath, '/tmp/babel-concurrent-right/file.txt')
    assert.equal(spawnIds.length, 2)
    await __testResetChildProcessSpawn()
  })
})
