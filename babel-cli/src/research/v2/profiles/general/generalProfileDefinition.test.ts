import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generalProfileDefinition, GENERAL_PROFILE_ID } from './generalProfileDefinition.js'

test('generalProfileDefinition: declarative M0 shape', () => {
  assert.equal(generalProfileDefinition.profileId, GENERAL_PROFILE_ID)
  assert.ok(generalProfileDefinition.preferredSourceClasses.includes('document'))
  assert.ok(generalProfileDefinition.reportSections.some((s) => s.sectionId === 'evidence'))
})
