import assert from 'node:assert/strict'
import { Command } from 'commander'
import { describe, it } from 'node:test'
import { registerResearchV2Commands } from './researchV2Commands.js'

describe('research v2 CLI registration', () => {
  it('registers dry-run and live gate commands under research v2', () => {
    const program = new Command()
    const research = program.command('research')
    registerResearchV2Commands(research)
    const names = research.commands.flatMap((cmd) => [cmd.name(), ...cmd.commands.map((c) => c.name())])
    assert.ok(names.includes('v2'))
    const v2 = research.commands.find((c) => c.name() === 'v2')
    assert.ok(v2)
    const sub = v2!.commands.map((c) => c.name())
    assert.ok(sub.includes('dry-run-plan'))
    assert.ok(sub.includes('live-status'))
    assert.ok(sub.includes('live-plan'))
    assert.ok(sub.includes('run'))
    assert.ok(sub.includes('inspect'))
    assert.ok(sub.includes('report'))
    assert.ok(sub.includes('cancel'))
    assert.ok(sub.includes('resume'))
    assert.ok(sub.includes('model-route'))
    assert.ok(sub.includes('cancel-resume-once'))
  })
})
