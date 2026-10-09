'use strict';
const {contextBridge, ipcRenderer} = require('electron');
// A fixed, narrow interface. No generic IPC, Node, shell, or credential API.
contextBridge.exposeInMainWorld('babelDesktop',Object.freeze({
  getInfo:()=>ipcRenderer.invoke('babel:get-info'),
  refreshDiagnostics:()=>ipcRenderer.invoke('babel:refresh-diagnostics'),
  saveProviderCredential:options=>ipcRenderer.invoke('babel:save-provider-credential',options),
  checkCliUpdate:()=>ipcRenderer.invoke('babel:check-cli-update'),
  updateDevCli:()=>ipcRenderer.invoke('babel:update-dev-cli'),
  updatePackagedCli:()=>ipcRenderer.invoke('babel:update-packaged-cli'),
  rebuildDevCli:()=>ipcRenderer.invoke('babel:rebuild-dev-cli'),
  setUpdateChannel:channel=>ipcRenderer.invoke('babel:set-update-channel',channel),
  listQualifiedProviders:()=>ipcRenderer.invoke('babel:list-qualified-providers'),
  chooseCli:()=>ipcRenderer.invoke('babel:choose-cli'),
  chooseProject:()=>ipcRenderer.invoke('babel:choose-project'),
  listSessions:()=>ipcRenderer.invoke('babel:list-sessions'),
  openSession:id=>ipcRenderer.invoke('babel:open-session',id),
  listDirectory:relative=>ipcRenderer.invoke('babel:list-directory',relative),
  readFile:relative=>ipcRenderer.invoke('babel:read-file',relative),
  run:request=>ipcRenderer.invoke('babel:run',request),
  decide:decision=>ipcRenderer.invoke('babel:decide',decision),
  cancel:()=>ipcRenderer.invoke('babel:cancel'),
  openRepository:()=>ipcRenderer.invoke('babel:open-repository'),
  onEvent:callback=>{
    if(typeof callback!=='function') throw new TypeError('Expected an event callback');
    const handler=(_event,packet)=>callback(packet);
    ipcRenderer.on('babel:event',handler);
    return ()=>ipcRenderer.removeListener('babel:event',handler);
  },
  onUpdateEvent:callback=>{
    if(typeof callback!=='function') throw new TypeError('Expected an update callback');
    const handler=(_event,event)=>callback(event);
    ipcRenderer.on('babel:update-event',handler);
    return ()=>ipcRenderer.removeListener('babel:update-event',handler);
  }
}));
