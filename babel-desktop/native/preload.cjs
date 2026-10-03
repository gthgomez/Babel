'use strict';
const {contextBridge, ipcRenderer} = require('electron');
// A fixed, narrow interface. No generic IPC, Node, shell, or credential API.
contextBridge.exposeInMainWorld('babelDesktop',Object.freeze({
  getInfo:()=>ipcRenderer.invoke('babel:get-info'),
  refreshDiagnostics:()=>ipcRenderer.invoke('babel:refresh-diagnostics'),
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
  }
}));
