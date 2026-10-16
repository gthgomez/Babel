/** undefined preserves legacy ambient state; null explicitly grants no project roots. */
export async function withProjectRootEnv<T>(projectRoot:string|null|undefined,allowedRoots:string[],fn:()=>Promise<T>):Promise<T> {
  if(projectRoot===undefined)return fn()
  const priorRoot=process.env['BABEL_PROJECT_ROOT'],priorAllowed=process.env['BABEL_ALLOWED_ROOTS']
  if(projectRoot===null){delete process.env['BABEL_PROJECT_ROOT'];delete process.env['BABEL_ALLOWED_ROOTS']}
  else {
    process.env['BABEL_PROJECT_ROOT']=projectRoot
    if(allowedRoots.length>0)process.env['BABEL_ALLOWED_ROOTS']=allowedRoots.join(',')
  }
  try{return await fn()}
  finally {
    if(priorRoot===undefined)delete process.env['BABEL_PROJECT_ROOT'];else process.env['BABEL_PROJECT_ROOT']=priorRoot
    if(priorAllowed===undefined)delete process.env['BABEL_ALLOWED_ROOTS'];else process.env['BABEL_ALLOWED_ROOTS']=priorAllowed
  }
}
