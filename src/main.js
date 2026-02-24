const { app, BrowserWindow, ipcMain, dialog, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildComparePlan, syncPlan: runSyncPlan } = require('./core/sync');
const {
  loadState,
  saveState,
  normalizeState,
  updateSelectedDirs,
  appendSyncHistory,
  clearSyncHistory,
} = require('./main/state-store');

let stateFilePath = null;
let appState = normalizeState({});
const appIconPath = path.join(__dirname, 'renderer', 'img', 'lempicka-icon.png');
app.setName('Lempicka Smart Sync');
app.name = 'Lempicka Smart Sync';
let windowContentWidth = 1100;
let activeSyncSession = null;
let syncJournalPath = null;

async function persistState() {
  if (!stateFilePath) {
    return appState;
  }
  appState = await saveState(stateFilePath, appState);
  return appState;
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  windowContentWidth = Math.min(1320, Math.max(960, workArea.width - 20));
  const initialHeight = Math.min(Math.max(760, 600), workArea.height - 40);

  const windowOptions = {
    title: '',
    useContentSize: true,
    width: windowContentWidth,
    minWidth: windowContentWidth,
    maxWidth: windowContentWidth,
    height: initialHeight,
    minHeight: 500,
    maxHeight: workArea.height - 20,
    resizable: false,
    fullscreenable: false,
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
  if (process.platform === 'darwin' && fs.existsSync(appIconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath));
  }

  stateFilePath = path.join(app.getPath('userData'), 'state.json');
  syncJournalPath = path.join(app.getPath('userData'), 'sync-recovery.json');

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

ipcMain.handle('clear-sync-history', async () => {
  appState = clearSyncHistory(appState);
  await persistState();
  return { cleared: true };
});

ipcMain.handle('set-window-content-height', (event, contentHeight) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return null;
  }

  const display = screen.getDisplayMatching(win.getBounds());
  const maxHeight = Math.max(500, display.workAreaSize.height - 20);
  const requested = Number(contentHeight);
  if (!Number.isFinite(requested)) {
    return null;
  }

  const targetHeight = Math.max(500, Math.min(maxHeight, Math.ceil(requested)));
  const [, currentContentHeight] = win.getContentSize();
  if (Math.abs(currentContentHeight - targetHeight) < 2) {
    return targetHeight;
  }

  win.setContentSize(windowContentWidth, targetHeight);
  return targetHeight;
});

ipcMain.handle('get-window-size-limits', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return { minContentHeight: 500, maxContentHeight: 800 };
  }

  const display = screen.getDisplayMatching(win.getBounds());
  const maxContentHeight = Math.max(500, display.workAreaSize.height - 20);
  return {
    minContentHeight: 500,
    maxContentHeight,
  };
});

ipcMain.handle('set-selected-directories', async (_, payload) => {
  appState = updateSelectedDirs(appState, payload || {});
  try {
    await persistState();
  } catch (error) {
    console.error('Failed to persist selected directories:', error);
    return {
      ...appState.selectedDirs,
      warning: 'Failed to persist selected directories.',
    };
  }
  return appState.selectedDirs;
});

ipcMain.handle('compare-trees', async (_, payload) => {
  const { leftRoot, rightRoot } = payload || {};
  if (!leftRoot || !rightRoot) {
    throw new Error('Both left and right directories are required.');
  }

  return buildComparePlan(leftRoot, rightRoot);
});

ipcMain.handle('cancel-sync', async () => {
  if (!activeSyncSession) {
    return { requested: false };
  }

  activeSyncSession.cancelRequested = true;
  return { requested: true };
});

ipcMain.handle('toggle-sync-pause', async () => {
  if (!activeSyncSession) {
    return { active: false, paused: false };
  }

  activeSyncSession.paused = !activeSyncSession.paused;
  return {
    active: true,
    paused: activeSyncSession.paused,
  };
});

async function appendHistoryFromSyncResult(result) {
  let warning = null;
  let logEntry = null;

  const files = Array.isArray(result && result.succeededFiles)
    ? result.succeededFiles.map((item) => ({
        sourceRelativePath: item.sourceRelativePath,
        targetRelativePath: item.targetRelativePath,
      }))
    : [];

  if (files.length === 0) {
    return { warning, logEntry };
  }

  try {
    const appended = appendSyncHistory(appState, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      leftRoot: typeof result.leftRoot === 'string' ? result.leftRoot : '',
      rightRoot: typeof result.rightRoot === 'string' ? result.rightRoot : '',
      copied: Number(result.copied) || 0,
      total: Number(result.total) || 0,
      files,
    });
    appState = appended.nextState;
    logEntry = appended.entry;
    await persistState();
  } catch (error) {
    console.error('Failed to persist sync history:', error);
    warning = 'History could not be saved.';
  }

  return { warning, logEntry };
}

function emptySyncResult() {
  return {
    copied: 0,
    total: 0,
    bytesCopied: 0,
    totalBytes: 0,
    failed: [],
    succeededFiles: [],
    durationMs: 0,
    averageThroughputBps: 0,
    leftRoot: '',
    rightRoot: '',
    resumedFromJournal: false,
  };
}

async function runWithSession(event, syncRun) {
  if (activeSyncSession) {
    throw new Error('A sync operation is already running.');
  }

  const syncSession = {
    cancelRequested: false,
    paused: false,
  };
  activeSyncSession = syncSession;

  let status = 'completed';
  let errorCode = '';
  let errorMessage = '';
  let result = emptySyncResult();

  try {
    result = await syncRun(syncSession);
  } catch (error) {
    status = error && error.code === 'SYNC_CANCELLED' ? 'cancelled' : 'error';
    errorCode = error && error.code ? error.code : 'SYNC_ERROR';
    errorMessage = error && error.message ? error.message : 'Sync failed.';

    const partialResult = error && error.details && error.details.partialResult;
    if (partialResult && typeof partialResult === 'object') {
      result = { ...emptySyncResult(), ...partialResult };
    }
  } finally {
    if (activeSyncSession === syncSession) {
      activeSyncSession = null;
    }
  }

  const { warning: historyWarning, logEntry } = await appendHistoryFromSyncResult(result);

  let warning = historyWarning;
  const failedCount = Array.isArray(result.failed) ? result.failed.length : 0;
  if (failedCount > 0) {
    const failedWarning = `${failedCount} file(s) failed and were skipped.`;
    warning = warning ? `${failedWarning} ${warning}` : failedWarning;
  }

  return {
    ...result,
    status,
    errorCode,
    errorMessage,
    warning,
    logEntry,
  };
}

ipcMain.handle('sync-plan', async (event, payload) => {
  const { plan, leftRoot, rightRoot, directoriesToCreate } = payload || {};

  return runWithSession(event, async (syncSession) => {
    return runSyncPlan(
      plan,
      (progress) => {
        event.sender.send('sync-progress', progress);
      },
      {
        leftRoot,
        rightRoot,
        directoriesToCreate,
        shouldCancel: () => syncSession.cancelRequested,
        shouldPause: () => syncSession.paused,
        continueOnError: true,
        retryCount: 2,
        retryBaseDelayMs: 300,
        maxParallelSmallFiles: 3,
        journalPath: syncJournalPath,
      }
    );
  });
});
