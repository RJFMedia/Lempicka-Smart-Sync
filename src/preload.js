const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('treeSync', {
  pickDirectory: (startPath) => ipcRenderer.invoke('pick-directory', startPath),
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  setSelectedDirectories: (leftRoot, rightRoot) =>
    ipcRenderer.invoke('set-selected-directories', { leftRoot, rightRoot }),
  compareTrees: (leftRoot, rightRoot) => ipcRenderer.invoke('compare-trees', { leftRoot, rightRoot }),
  syncPlan: (plan, leftRoot, rightRoot) => ipcRenderer.invoke('sync-plan', { plan, leftRoot, rightRoot }),
  onSyncProgress: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('sync-progress', listener);
    return () => ipcRenderer.removeListener('sync-progress', listener);
  },
});
