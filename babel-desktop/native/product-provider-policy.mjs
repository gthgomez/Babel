// Product gateway policy. Keep in sync with the CLI provider registry.
export function isApprovedDesktopProvider(provider){
  return provider==='openrouter'||provider==='command-code';
}
export function assertApprovedDesktopProvider(provider){
  if(!isApprovedDesktopProvider(provider))throw new Error('Unsupported provider. Choose OpenRouter or Command Code; existing settings were retained.');
}
export function isDesktopOffline(){return ['1','true'].includes(process.env.BABEL_OFFLINE??'');}
export function offlineBlocksEndpoint(endpoint){
  if(!isDesktopOffline())return false;
  try{const url=new URL(endpoint);return !(['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));}
  catch{return true;}
}
