import assert from 'node:assert/strict'
import test from 'node:test'
import {withProjectRootEnv} from './projectRootEnv.js'
test('explicit conversation root clears ambient authority during work and restores it on failure',async()=>{
  const root=process.env['BABEL_PROJECT_ROOT'],allowed=process.env['BABEL_ALLOWED_ROOTS']
  try {
    process.env['BABEL_PROJECT_ROOT']='prior-root';process.env['BABEL_ALLOWED_ROOTS']='prior-allowed'
    await assert.rejects(withProjectRootEnv(null,['must-not-grant'],async()=>{
      assert.equal(process.env['BABEL_PROJECT_ROOT'],undefined)
      assert.equal(process.env['BABEL_ALLOWED_ROOTS'],undefined)
      throw new Error('fixture interruption')
    }),/fixture interruption/)
    assert.equal(process.env['BABEL_PROJECT_ROOT'],'prior-root')
    assert.equal(process.env['BABEL_ALLOWED_ROOTS'],'prior-allowed')
    await withProjectRootEnv(undefined,[],async()=>{assert.equal(process.env['BABEL_PROJECT_ROOT'],'prior-root')})
    await withProjectRootEnv('explicit-root',['explicit-allowed'],async()=>{
      assert.equal(process.env['BABEL_PROJECT_ROOT'],'explicit-root')
      assert.equal(process.env['BABEL_ALLOWED_ROOTS'],'explicit-allowed')
    })
  }finally{
    if(root===undefined)delete process.env['BABEL_PROJECT_ROOT'];else process.env['BABEL_PROJECT_ROOT']=root
    if(allowed===undefined)delete process.env['BABEL_ALLOWED_ROOTS'];else process.env['BABEL_ALLOWED_ROOTS']=allowed
  }
})
