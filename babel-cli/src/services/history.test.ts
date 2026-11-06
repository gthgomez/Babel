import assert from 'node:assert/strict'
import test from 'node:test'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {tmpdir} from 'node:os'

const historyModule=new URL('./history.ts',import.meta.url).href
const script=`
import assert from 'node:assert/strict'
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
const {loadHistory,saveHistory}=await import(${JSON.stringify(historyModule)})
const local=join(process.cwd(),'.babel_history')
const profile=process.env.BABEL_STATE_DIR
const privateFile=join(profile,'.babel_history')
switch(process.argv[1]){
  case 'private':
    saveHistory(['new task'])
    assert.equal(existsSync(local),false,'interactive history must not create a repository file')
    assert.deepEqual(JSON.parse(readFileSync(privateFile,'utf8')),['new task'])
    break
  case 'legacy': {
    const legacy='["legacy command"]\\n'
    writeFileSync(local,legacy)
    assert.deepEqual(loadHistory(),['legacy command'])
    saveHistory(['new task'])
    assert.equal(readFileSync(local,'utf8'),legacy,'legacy repository history must remain byte-identical')
    assert.deepEqual(loadHistory(),['new task'])
    break
  }
  case 'late-profile': {
    saveHistory(['first profile'])
    const second=join(profile,'..','second-profile')
    process.env.BABEL_STATE_DIR=second
    saveHistory(['second profile'])
    assert.deepEqual(loadHistory(),['second profile'])
    assert.deepEqual(JSON.parse(readFileSync(privateFile,'utf8')),['first profile'])
    assert.equal(existsSync(local),false)
    break
  }
  case 'bounded-and-malformed':
    saveHistory(Array.from({length:105},(_,index)=>String(index)))
    assert.equal(loadHistory().length,100)
    mkdirSync(profile,{recursive:true})
    writeFileSync(privateFile,'invalid json')
    assert.deepEqual(loadHistory(),[])
    break
  case 'unwritable':
    writeFileSync(profile,'not a directory')
    saveHistory(['must stay out of repository'])
    assert.equal(existsSync(local),false,'an unavailable private profile must not fall back to repository writes')
    break
  default: throw new Error('Unknown isolated history case')
}
`

for(const scenario of ['private','legacy','late-profile','bounded-and-malformed','unwritable']){
  test(`interactive history ${scenario}`,()=>{
    const root=mkdtempSync(join(tmpdir(),'babel-history-'))
    assert.equal(dirname(resolve(root)),resolve(tmpdir()))
    const project=join(root,'repository')
    mkdirSync(project)
    try{
      const child=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script,scenario],{
        cwd:project,env:{...process.env,BABEL_STATE_DIR:join(root,'profile'),BABEL_OFFLINE:'1'},
        encoding:'utf8',windowsHide:true,
      })
      assert.equal(child.status,0,child.stderr||'isolated history persistence failed')
    }finally{rmSync(root,{recursive:true,force:true})}
  })
}
