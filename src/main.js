const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, nativeImage, screen, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { buildComparePlan, syncPlan: runSyncPlan } = require('./core/sync');
const {
  loadState,
  saveState,
  normalizeState,
  updateSelectedDirs,
  appendSyncHistory,
  clearSyncHistory,
} = require('./main/state-store');

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APP_OPERATION = Object.freeze({
  IDLE: 'idle',
  COMPARING: 'comparing',
  SYNCING: 'syncing',
});

let stateFilePath = null;
let appState = normalizeState({});
const appIconPath = path.join(__dirname, 'renderer', 'img', 'lempicka-icon.png');
app.setName('Lempicka Smart Sync');
app.name = 'Lempicka Smart Sync';
let windowContentWidth = 1100;
let activeSyncSession = null;
let syncJournalPath = null;
let mainWindow = null;
let updateCheckerTimer = null;
let autoUpdaterConfigured = false;
let manualUpdateCheckInProgress = false;
let appOperation = APP_OPERATION.IDLE;
let lastCompareContext = null;

function normalizeRootForState(rawPath) {
  const resolved = path.resolve(String(rawPath || ''));
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return resolved.toLowerCase();
  }
  return resolved;
}

function buildPlanDigest(payload) {
  const normalizedPlan = Array.isArray(payload && payload.plan)
    ? payload.plan.map((item) => ({
        sourcePath: String(item && item.sourcePath ? item.sourcePath : ''),
        sourceRelativePath: String(item && item.sourceRelativePath ? item.sourceRelativePath : ''),
        sourceSize: Number(item && item.sourceSize ? item.sourceSize : 0),
        targetPath: String(item && item.targetPath ? item.targetPath : ''),
        targetRelativePath: String(item && item.targetRelativePath ? item.targetRelativePath : ''),
        version: Number(item && item.version ? item.version : 0),
        destinationExists: Boolean(item && item.destinationExists),
        destinationSize: Number.isFinite(Number(item && item.destinationSize))
          ? Number(item.destinationSize)
          : null,
      }))
    : [];

  const normalizedDirs = Array.isArray(payload && payload.directoriesToCreate)
    ? payload.directoriesToCreate.map((value) => String(value || '')).sort()
    : [];

  const body = {
    leftRoot: normalizeRootForState(payload && payload.leftRoot ? payload.leftRoot : ''),
    rightRoot: normalizeRootForState(payload && payload.rightRoot ? payload.rightRoot : ''),
    plan: normalizedPlan,
    directoriesToCreate: normalizedDirs,
  };

  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function createCompareContext(compareResult) {
  const digest = buildPlanDigest(compareResult);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    token: `${nonce}.${digest.slice(0, 12)}`,
    digest,
    leftRoot: normalizeRootForState(compareResult.leftRoot),
    rightRoot: normalizeRootForState(compareResult.rightRoot),
    createdAt: new Date().toISOString(),
  };
}

function clearCompareContext() {
  lastCompareContext = null;
}

function setOperation(next) {
  appOperation = next;
}

function assertIdleOperation(actionLabel) {
  if (appOperation !== APP_OPERATION.IDLE) {
    throw new Error(`${actionLabel} is not allowed while another operation is running.`);
  }
}

function verifyCompareContextForSync(payload) {
  const compareToken = typeof payload.compareToken === 'string' ? payload.compareToken : '';
  if (!compareToken || !lastCompareContext || compareToken !== lastCompareContext.token) {
    throw new Error('Compare results are stale. Run Compare again before syncing.');
  }

  const leftRoot = normalizeRootForState(payload.leftRoot || '');
  const rightRoot = normalizeRootForState(payload.rightRoot || '');
  if (leftRoot !== lastCompareContext.leftRoot || rightRoot !== lastCompareContext.rightRoot) {
    throw new Error('Selected directories changed after compare. Run Compare again before syncing.');
  }

  const payloadDigest = buildPlanDigest(payload);
  if (payloadDigest !== lastCompareContext.digest) {
    throw new Error('Sync plan changed after compare. Run Compare again before syncing.');
  }
}


function getContentHeightBounds(workAreaHeight) {
  const maxContentHeight = Math.max(320, Number(workAreaHeight) - 20);
  const minContentHeight = Math.min(320, maxContentHeight);
  return { minContentHeight, maxContentHeight };
}

async function persistState() {
  if (!stateFilePath) {
    return appState;
  }
  appState = await saveState(stateFilePath, appState);
  return appState;
}

function getActiveWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  const existing = BrowserWindow.getAllWindows();
  return existing.length > 0 ? existing[0] : null;
}


async function promptAndInstallUpdate(info) {
  const win = getActiveWindow();
  const versionText = info && info.version ? info.version : 'a new version';

  if (!win || win.isDestroyed()) {
    autoUpdater.quitAndInstall();
    return;
  }

  const result = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Ready',
    message: `Lempicka Smart Sync ${versionText} has been downloaded.`,
    detail: 'Restart now to install the update.',
  });

  if (result.response === 0) {
    autoUpdater.quitAndInstall();
  }
}

async function checkForUpdatesSilently() {
  if (!app.isPackaged) {
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error && error.message ? error.message : 'Update check failed.';
    console.error('Silent update check failed:', message);
  }
}

async function checkForUpdatesManually() {
  const win = getActiveWindow();
  if (!app.isPackaged) {
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Check for Updates',
      message: 'Updates are available only in packaged builds of Lempicka Smart Sync.',
    });
    return;
  }

  if (manualUpdateCheckInProgress) {
    return;
  }
  manualUpdateCheckInProgress = true;

  try {
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const onAvailable = (info) => {
        settle({
          type: 'available',
          message: 'Update ' + (info && info.version ? info.version : 'available') + ' is downloading in the background.',
        });
      };
      const onNotAvailable = () => {
        settle({
          type: 'none',
          message: 'Lempicka Smart Sync ' + app.getVersion() + ' is up to date.',
        });
      };
      const onError = (error) => {
        settle({
          type: 'error',
          message: error && error.message ? error.message : 'Update check failed.',
        });
      };

      const cleanup = () => {
        autoUpdater.removeListener('update-available', onAvailable);
        autoUpdater.removeListener('update-not-available', onNotAvailable);
        autoUpdater.removeListener('error', onError);
      };

      autoUpdater.once('update-available', onAvailable);
      autoUpdater.once('update-not-available', onNotAvailable);
      autoUpdater.once('error', onError);

      autoUpdater.checkForUpdates().catch((error) => {
        settle({
          type: 'error',
          message: error && error.message ? error.message : 'Update check failed.',
        });
      });
    });

    await dialog.showMessageBox(win, {
      type: outcome.type === 'error' ? 'error' : 'info',
      title: 'Check for Updates',
      message: outcome.message,
    });
  } finally {
    manualUpdateCheckInProgress = false;
  }
}

function setupApplicationMenu() {
  if (process.platform !== 'darwin') {
    return;
  }

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'About Lempicka Smart Sync' },
        {
          label: 'Check for Updates...',
          click: () => {
            checkForUpdatesManually().catch((error) => {
              console.error('Manual update check failed:', error);
            });
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupAutoUpdates() {
  if (autoUpdaterConfigured || !app.isPackaged) {
    return;
  }

  autoUpdaterConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    promptAndInstallUpdate(info).catch((error) => {
      console.error('Failed to prompt for update install:', error);
    });
  });
  autoUpdater.on('error', (error) => {
    const message = error && error.message ? error.message : 'Unknown update error.';
    console.error('Auto update error:', message);
  });

  setTimeout(() => {
    checkForUpdatesSilently().catch(() => undefined);
  }, 5000);

  updateCheckerTimer = setInterval(() => {
    checkForUpdatesSilently().catch(() => undefined);
  }, UPDATE_CHECK_INTERVAL_MS);
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const { minContentHeight, maxContentHeight } = getContentHeightBounds(workArea.height);
  windowContentWidth = Math.min(1100, Math.max(1040, workArea.width - 20));
  const initialHeight = Math.min(Math.max(760, minContentHeight), maxContentHeight);

  const windowOptions = {
    title: '',
    useContentSize: true,
    width: windowContentWidth,
    minWidth: windowContentWidth,
    maxWidth: windowContentWidth,
    height: initialHeight,
    minHeight: minContentHeight,
    maxHeight: maxContentHeight,
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

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;
  return win;
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
  setupApplicationMenu();
  setupAutoUpdates();

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

app.on('before-quit', () => {
  if (updateCheckerTimer) {
    clearInterval(updateCheckerTimer);
    updateCheckerTimer = null;
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

ipcMain.handle('validate-directory-path', async (_, candidatePath) => {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
    return { ok: false, error: 'No dropped path provided.' };
  }

  const resolved = path.resolve(candidatePath);

  try {
    const stats = await fs.promises.stat(resolved);
    if (!stats.isDirectory()) {
      return { ok: false, error: 'Dropped item is not a directory.' };
    }
    return { ok: true, path: resolved };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, error: 'Dropped directory no longer exists.' };
    }
    return {
      ok: false,
      error: error && error.message ? error.message : 'Could not access dropped directory.',
    };
  }
});

ipcMain.handle('get-app-state', async () => {
  return appState;
});

ipcMain.handle('copy-text', async (_, text) => {
  clipboard.writeText(typeof text === 'string' ? text : String(text || ''));
  return { ok: true };
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: 'not-packaged' };
  }

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'check-failed',
      message: error && error.message ? error.message : 'Update check failed.',
    };
  }
});

ipcMain.handle('install-update-now', async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: 'not-packaged' };
  }

  autoUpdater.quitAndInstall();
  return { ok: true };
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
  const { minContentHeight, maxContentHeight } = getContentHeightBounds(display.workAreaSize.height);
  const requested = Number(contentHeight);
  if (!Number.isFinite(requested)) {
    return null;
  }

  const targetHeight = Math.max(minContentHeight, Math.min(maxContentHeight, Math.ceil(requested)));
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
    return { minContentHeight: 320, maxContentHeight: 800 };
  }

  const display = screen.getDisplayMatching(win.getBounds());
  const { minContentHeight, maxContentHeight } = getContentHeightBounds(display.workAreaSize.height);
  return {
    minContentHeight,
    maxContentHeight,
  };
});

ipcMain.handle('set-selected-directories', async (_, payload) => {
  const incoming = payload || {};
  const nextLeft = normalizeRootForState(incoming.leftRoot || '');
  const nextRight = normalizeRootForState(incoming.rightRoot || '');

  if (
    lastCompareContext
    && (nextLeft !== lastCompareContext.leftRoot || nextRight !== lastCompareContext.rightRoot)
  ) {
    clearCompareContext();
  }

  appState = updateSelectedDirs(appState, incoming);
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

  assertIdleOperation('Compare');
  setOperation(APP_OPERATION.COMPARING);

  try {
    const result = await buildComparePlan(leftRoot, rightRoot);
    const compareContext = createCompareContext(result);
    lastCompareContext = compareContext;

    return {
      ...result,
      compareToken: compareContext.token,
    };
  } catch (error) {
    clearCompareContext();
    throw error;
  } finally {
    setOperation(APP_OPERATION.IDLE);
  }
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

  assertIdleOperation('Sync');
  verifyCompareContextForSync(payload || {});
  clearCompareContext();
  setOperation(APP_OPERATION.SYNCING);

  try {
    return await runWithSession(event, async (syncSession) => {
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
  } finally {
    setOperation(APP_OPERATION.IDLE);
  }
});
