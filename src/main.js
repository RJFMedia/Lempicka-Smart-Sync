const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildComparePlan, syncPlan: runSyncPlan } = require('./core/sync');
const {
  loadState,
  saveState,
  normalizeState,
  updateSelectedDirs,
  appendSyncHistory,
} = require('./main/state-store');

let stateFilePath = null;
let appState = normalizeState({});
const appIconPath = path.join(__dirname, 'renderer', 'img', 'lempicka-icon.png');

async function persistState() {
  if (!stateFilePath) {
    return appState;
  }
  appState = await saveState(stateFilePath, appState);
  return appState;
}

function createWindow() {
  const windowOptions = {
    title: 'Lempicka Smart Sync',
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (fs.existsSync(appIconPath)) {
    windowOptions.icon = appIconPath;
  }

  const win = new BrowserWindow({
    ...windowOptions,
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  app.setName('Lempicka Smart Sync');
  if (process.platform === 'darwin' && fs.existsSync(appIconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath));
  }
  stateFilePath = path.join(app.getPath('userData'), 'state.json');
  try {
    appState = await loadState(stateFilePath);
  } catch (error) {
    console.error('Failed to load persisted app state:', error);
    appState = normalizeState({});
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('pick-directory', async (_, startPath) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: startPath || undefined,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('get-app-state', async () => {
  return appState;
});

ipcMain.handle('set-selected-directories', async (_, payload) => {
  appState = updateSelectedDirs(appState, payload || {});
  await persistState();
  return appState.selectedDirs;
});

ipcMain.handle('compare-trees', async (_, payload) => {
  const { leftRoot, rightRoot } = payload || {};
  if (!leftRoot || !rightRoot) {
    throw new Error('Both left and right directories are required.');
  }

  return buildComparePlan(leftRoot, rightRoot);
});

ipcMain.handle('sync-plan', async (event, payload) => {
  const { plan, leftRoot, rightRoot } = payload || {};
  const result = await runSyncPlan(plan, (progress) => {
    event.sender.send('sync-progress', progress);
  });

  const { nextState, entry } = appendSyncHistory(appState, {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    leftRoot: typeof leftRoot === 'string' ? leftRoot : '',
    rightRoot: typeof rightRoot === 'string' ? rightRoot : '',
    copied: result.copied,
    total: result.total,
    files: Array.isArray(plan) ? plan.map((item) => item.targetRelativePath) : [],
  });
  appState = nextState;
  await persistState();

  return {
    ...result,
    logEntry: entry,
  };
});
