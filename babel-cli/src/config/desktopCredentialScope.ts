/** Native Desktop has already selected one credential destination/provider. */
export function usesDesktopResolvedCredentials(env:NodeJS.ProcessEnv):boolean{
  return env['BABEL_DESKTOP_IPC']==='1'&&env['BABEL_DESKTOP_CREDENTIALS_RESOLVED']==='1'
}
