import assert from 'node:assert/strict'
import test from 'node:test'
import { VirtualTerminal } from '../interactive/testing/ptyHarness.js'
import { openSetupPrompt, SetupCancelled } from './setupPrompt.js'

test('the setup reader handles fragmented bracketed paste without echo or carryover', async t => {
  const terminal = new VirtualTerminal()
  const prompt = openSetupPrompt(text => terminal.stderr.write(text), terminal.stdin as NodeJS.ReadStream)
  t.after(prompt.close)
  const masked = prompt.question('Paste API key: ', true)
  const key = 'synthetic-fragmented-key'
  terminal.sendInput(`\x1b[20`)
  terminal.sendInput(`0~${key}\x1b[2`)
  terminal.sendInput('01~\rignored-trailing-bytes')
  assert.equal(await masked === key, true)
  assert.equal(terminal.getRawOutput().includes(key), false)
  const next = prompt.question('Choice: ')
  terminal.sendInput('\x1b[200~1\r2\x1b[201~\r')
  assert.equal(await terminal.waitForOutput('Use a single line'), true)
  terminal.sendInput('2\r')
  assert.equal(await next, '2')
})

test('Esc goes back, Ctrl+C or EOF settles the prompt, and raw mode is restored', async t => {
  for (const eof of [false, true]) {
    const terminal = new VirtualTerminal()
    const prompt = openSetupPrompt(text => terminal.stderr.write(text), terminal.stdin as NodeJS.ReadStream)
    try {
      const back = prompt.question('Choice: ')
      terminal.sendInput('\x1b')
      assert.equal(await back, null)
      const pending = prompt.question('Key: ', true)
      if (eof) terminal.stdin.push(null)
      else terminal.sendCtrlC()
      await assert.rejects(pending, SetupCancelled)
    } finally { prompt.close() }
    assert.equal(terminal.isRaw, false)
  }
})
