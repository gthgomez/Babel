import assert from 'node:assert/strict'
import test from 'node:test'
import {desktopCapabilities,isDesktopCapabilityProbe} from './desktopCapabilities.js'

test('credential capability advertises the implemented native resolution contract only',()=>{
  assert.deepEqual(desktopCapabilities(),{schemaVersion:1,credentialEnvironment:'native-resolved-v1'})
  assert.equal(Object.isFrozen(desktopCapabilities()),true)
})

test('capability probe is recognized only as its sole pre-task option',()=>{
  assert.equal(isDesktopCapabilityProbe(['node','index.js','--desktop-capabilities']),true)
  for(const args of [[],['node','index.js'],['node','index.js','run','--','--desktop-capabilities'],['node','index.js','--desktop-capabilities','run'],['node','index.js','run','--desktop-capabilities']])assert.equal(isDesktopCapabilityProbe(args),false)
})
