const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('treeSync', {
  pickDirectory: (startPath) => ipcRenderer.invoke('pick-directory', startPath),
  validateDirectoryPath: (candidatePath) => ipcRenderer.invoke('validate-directory-path', candidatePath),
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  getWindowSizeLimits: () => ipcRenderer.invoke('get-window-size-limits'),
  setWindowContentHeight: (contentHeight) => ipcRenderer.invoke('set-window-content-height', contentHeight),
  clearSyncHistory: () => ipcRenderer.invoke('clear-sync-history'),
  setSelectedDirectories: (leftRoot, rightRoot) =>
    ipcRenderer.invoke('set-selected-directories', { leftRoot, rightRoot }),
  compareTrees: (leftRoot, rightRoot) => ipcRenderer.invoke('compare-trees', { leftRoot, rightRoot }),
  syncPlan: (plan, leftRoot, rightRoot, directoriesToCreate, compareToken) =>
    ipcRenderer.invoke('sync-plan', { plan, leftRoot, rightRoot, directoriesToCreate, compareToken }),
  cancelSync: () => ipcRenderer.invoke('cancel-sync'),
  toggleSyncPause: () => ipcRenderer.invoke('toggle-sync-pause'),
  onSyncProgress: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('sync-progress', listener);
    return () => ipcRenderer.removeListener('sync-progress', listener);
  }
});
