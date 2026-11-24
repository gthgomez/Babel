import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ShellRuntimeBinding } from '../../ui/shell/shellRuntimeBinding.js'
import { HostedGovernedRenderer } from './hostedGovernedRenderer.js'

test('governed progress and streamed answers stay in the owned shell and reject stale events', () => {
  const bus = new EventEmitter()
  const shell = new ShellRuntimeBinding({ width: 100 })
  shell.beginTurn(1, 'fixture task', 'fixture-session')
  const originalWrite = process.stdout.write
  const raw: string[] = []
  process.stdout.write = ((chunk: unknown) => { raw.push(String(chunk)); return true }) as typeof process.stdout.write
  try {
    const renderer = new HostedGovernedRenderer(bus, { task: 'fixture task' }, shell, () => true)
    renderer.start()
    bus.emit('stage', 2)
    bus.emit('assistant_chunk', { chunk: 'Useful answer' })
    bus.emit('assistant_chunk', { chunk: '\x1b]0;untrusted-title' })
    bus.emit('assistant_chunk', { chunk: '\x07 more text' })
    bus.emit('assistant_thought', '\x1b]8;;file:///unsafe-thought')
    bus.emit('assistant_thought', '\x07thought\x1b]8;;\x07')
    assert.match(shell.getVisibleRows(100, 30).join('\n'), /Useful answer/)
    assert.match(renderer.getTranscript(), /Useful answer/)
    assert.doesNotMatch(renderer.getTranscript(), /\x1b|untrusted-title|unsafe-thought/)
    assert.doesNotMatch(shell.getVisibleRows(100, 30).join('\n'), /\x1b\]0;|untrusted-title|unsafe-thought|\x1b\]8/)
    assert.deepEqual(raw, [])
    shell.hydrateTurns([], 'new-session')
    bus.emit('assistant_chunk', { chunk: 'stale answer' })
    bus.emit('stage', 3)
    assert.doesNotMatch(shell.getVisibleRows(100, 30).join('\n'), /stale answer|Reviewing/)
    assert.doesNotMatch(renderer.getTranscript(), /stale answer/)
    renderer.stop()
    assert.equal(bus.listenerCount('assistant_chunk'), 0)
  } finally { process.stdout.write = originalWrite }
})
