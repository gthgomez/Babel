import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

test('common dry-run packaging stops a source-provenance rejection before build or pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-package-rejection-'))
  const pkg = join(root, 'babel-cli'), log = join(root, 'calls.log')
  function git(...args) {
    const r = spawnSync('git', args, {cwd:root,encoding:'utf8'})
    assert.equal(r.status,0,r.stderr)
  }
  try {
    mkdirSync(join(pkg,'scripts'),{recursive:true})
    for (const script of ['prepare_release_package.mjs', 'write_build_info.mjs', 'consumer_archive.mjs']) {
      copyFileSync(new URL('../../babel-cli/scripts/' + script, import.meta.url), join(pkg, 'scripts', script))
    }
    writeFileSync(join(root,'.gitignore'),'calls.log\noutput/\n')
    writeFileSync(join(pkg, 'package.json'), '{"version":"1.0.0"}\n')
    const npm = join(root,'fake-npm.mjs')
    writeFileSync(npm,"import {appendFileSync} from 'node:fs'; appendFileSync(process.env.FIXTURE_CALL_LOG,process.argv.slice(2).join(' ')+'\\n'); process.exit(7);")
    git('init','-q'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture')
    git('add','babel-cli','.gitignore','fake-npm.mjs'); git('commit','-qm','fixture')
    const r = spawnSync(process.execPath,['scripts/prepare_release_package.mjs',join(root,'output')],
      {cwd:pkg,env:{...process.env,npm_execpath:npm,FIXTURE_CALL_LOG:log},encoding:'utf8'})
    assert.notEqual(r.status,0)
    assert.equal(readFileSync(log,'utf8'),'run check:source-provenance\n')
  } finally {rmSync(root,{recursive:true,force:true})}
})
