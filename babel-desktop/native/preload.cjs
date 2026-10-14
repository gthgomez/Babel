'use strict';
const {contextBridge, ipcRenderer} = require('electron');
// A fixed, narrow interface. No generic IPC, Node, shell, or credential API.
contextBridge.exposeInMainWorld('babelDesktop',Object.freeze({
  getInfo:()=>ipcRenderer.invoke('babel:get-info'),
  refreshDiagnostics:()=>ipcRenderer.invoke('babel:refresh-diagnostics'),
  configureSandbox:options=>ipcRenderer.invoke('babel:configure-sandbox',options),
  saveProviderCredential:options=>ipcRenderer.invoke('babel:save-provider-credential',options),
  readProviderRoute:()=>ipcRenderer.invoke('babel:read-provider-route'),
  saveProviderRoute:options=>ipcRenderer.invoke('babel:save-provider-route',options),
  checkCliUpdate:()=>ipcRenderer.invoke('babel:check-cli-update'),
  updateDevCli:()=>ipcRenderer.invoke('babel:update-dev-cli'),
  updatePackagedCli:()=>ipcRenderer.invoke('babel:update-packaged-cli'),
  rebuildDevCli:()=>ipcRenderer.invoke('babel:rebuild-dev-cli'),
  setUpdateChannel:channel=>ipcRenderer.invoke('babel:set-update-channel',channel),
  listQualifiedProviders:()=>ipcRenderer.invoke('babel:list-qualified-providers'),
  refreshModels:provider=>ipcRenderer.invoke('babel:refresh-models',provider),
  chooseCli:()=>ipcRenderer.invoke('babel:choose-cli'),
  chooseProject:()=>ipcRenderer.invoke('babel:choose-project'),
  listSessions:options=>ipcRenderer.invoke('babel:list-sessions',options),
  openSession:(id, options)=>ipcRenderer.invoke('babel:open-session',id, options),
  listDirectory:relative=>ipcRenderer.invoke('babel:list-directory',relative),
  readFile:relative=>ipcRenderer.invoke('babel:read-file',relative),
  run:request=>ipcRenderer.invoke('babel:run',request),
  decide:decision=>ipcRenderer.invoke('babel:decide',decision),
  cancel:()=>ipcRenderer.invoke('babel:cancel'),
  startRemoteBridge:options=>ipcRenderer.invoke('babel:start-remote-bridge',options),
  stopRemoteBridge:()=>ipcRenderer.invoke('babel:stop-remote-bridge'),
  openRepository:()=>ipcRenderer.invoke('babel:open-repository'),
  onEvent:callback=>{
    if(typeof callback!=='function') throw new TypeError('Expected an event callback');
    const handler=(_event,packet)=>callback(packet);
    ipcRenderer.on('babel:event',handler);
    return ()=>ipcRenderer.removeListener('babel:event',handler);
  },
  onRemoteLog:callback=>{
    if(typeof callback!=='function') throw new TypeError('Expected a remote log callback');
    const handler=(_event,payload)=>callback(payload);
    ipcRenderer.on('babel:remote-log',handler);
    return ()=>ipcRenderer.removeListener('babel:remote-log',handler);
  },
  onUpdateEvent:callback=>{
    if(typeof callback!=='function') throw new TypeError('Expected an update callback');
    const handler=(_event,event)=>callback(event);
    ipcRenderer.on('babel:update-event',handler);
    return ()=>ipcRenderer.removeListener('babel:update-event',handler);
  }
}));
