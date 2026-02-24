const leftPathInput = document.getElementById('leftPath');
const rightPathInput = document.getElementById('rightPath');
const pickLeftBtn = document.getElementById('pickLeft');
const pickRightBtn = document.getElementById('pickRight');
const compareBtn = document.getElementById('compareBtn');
const syncBtn = document.getElementById('syncBtn');
const statusText = document.getElementById('statusText');
const resultsBody = document.getElementById('resultsBody');
const historyBody = document.getElementById('historyBody');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const progressBar = document.getElementById('progressBar');
const resultPanels = Array.from(document.querySelectorAll('.results'));

let currentPlan = [];
let currentDirectoriesToCreate = [];
let isBusy = false;
let syncHistory = [];
let lastRequestedWindowHeight = 0;
let windowHeightUpdateQueued = false;
let maxContentHeightLimit = window.innerHeight;
let smoothedThroughputBps = 0;

function messageFromError(error, fallback) {
  if (!error) {
    return fallback;
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  pickLeftBtn.disabled = nextBusy;
  pickRightBtn.disabled = nextBusy;
  compareBtn.disabled = nextBusy;
  syncBtn.disabled = nextBusy || currentPlan.length === 0;
  clearHistoryBtn.disabled = nextBusy || syncHistory.length === 0;
}

function setPlainStatus(message) {
  statusText.classList.remove('sync-live');
  statusText.textContent = message;
}

function setSyncStatus(leftText, rightText) {
  statusText.classList.add('sync-live');
  statusText.innerHTML = '';

  const left = document.createElement('span');
  left.className = 'sync-left';
  left.textContent = leftText;

  const right = document.createElement('span');
  right.className = 'sync-right';
  right.textContent = rightText;

  statusText.appendChild(left);
  statusText.appendChild(right);
}

function formatSize(bytes) {
  return Number(bytes).toLocaleString();
}

function formatBytesHuman(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes) || 0;
  let unitIndex = 0;

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatSpeed(bytesPerSecond) {
  const safe = Number(bytesPerSecond) || 0;
  return `${formatBytesHuman(safe)}/s`;
}

function formatEta(seconds) {
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function clearResults(message) {
  resultsBody.innerHTML = '';
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 5;
  cell.className = 'empty';
  cell.textContent = message;
  row.appendChild(cell);
  resultsBody.appendChild(row);
}

function clearHistory(message) {
  historyBody.innerHTML = '';
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 3;
  cell.className = 'empty';
  cell.textContent = message;
  row.appendChild(cell);
  historyBody.appendChild(row);
}

function formatTimestamp(isoTimestamp) {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp || '(unknown)';
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hour = String(parsed.getHours()).padStart(2, '0');
  const minute = String(parsed.getMinutes()).padStart(2, '0');
  const second = String(parsed.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function fileNameOnly(relativeOrFilePath) {
  const raw = String(relativeOrFilePath || '').trim();
  if (!raw) {
    return '(not recorded)';
  }
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}

function relativePathText(relativeOrFilePath) {
  const raw = String(relativeOrFilePath || '').trim();
  return raw || '(not recorded)';
}

function normalizeHistoryFiles(item) {
  const files = Array.isArray(item.files) ? item.files : [];
  const normalized = [];
  for (const file of files) {
    if (typeof file === 'string') {
      normalized.push({ sourceRelativePath: '', targetRelativePath: file });
      continue;
    }
    if (!file || typeof file !== 'object') {
      continue;
    }
    normalized.push({
      sourceRelativePath: typeof file.sourceRelativePath === 'string' ? file.sourceRelativePath : '',
      targetRelativePath: typeof file.targetRelativePath === 'string' ? file.targetRelativePath : '',
    });
  }
  return normalized.length ? normalized : [{ sourceRelativePath: '', targetRelativePath: '' }];
}

function updateResultsPanelHeights() {
  const appRoot = document.querySelector('.app');
  if (!appRoot || resultPanels.length === 0) {
    return;
  }

  const appStyle = window.getComputedStyle(appRoot);
  const appBottomPadding = Number.parseFloat(appStyle.paddingBottom) || 0;

  const firstPanelTop = resultPanels[0].getBoundingClientRect().top;
  const heightBudget = Math.max(window.innerHeight, maxContentHeightLimit);
  const availableForAllPanels = Math.max(
    200,
    heightBudget - firstPanelTop - appBottomPadding - 10
  );
  const perPanelCap = availableForAllPanels / resultPanels.length;

  for (const panel of resultPanels) {
    const panelCap = perPanelCap;
    panel.style.setProperty('--panel-max-height', `${panelCap}px`);

    const tableScroll = panel.querySelector('.table-scroll');
    if (!tableScroll) {
      continue;
    }

    const computed = window.getComputedStyle(panel);
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
    const gap = Number.parseFloat(computed.rowGap || computed.gap) || 0;

    const header = panel.querySelector('.results-header') || panel.querySelector('h2');
    const headerHeight = header ? header.getBoundingClientRect().height : 0;

    const availableHeight = Math.max(
      72,
      panelCap - paddingTop - paddingBottom - gap - headerHeight
    );
    tableScroll.style.maxHeight = `${availableHeight}px`;
  }

  queueWindowHeightUpdate();
}

function queueWindowHeightUpdate() {
  if (windowHeightUpdateQueued) {
    return;
  }
  windowHeightUpdateQueued = true;
  window.requestAnimationFrame(async () => {
    windowHeightUpdateQueued = false;
    const doc = document.documentElement;
    const body = document.body;
    const desired = Math.ceil(Math.max(doc.scrollHeight, body.scrollHeight));
    if (!desired || Math.abs(desired - lastRequestedWindowHeight) < 2) {
      return;
    }

    try {
      await window.treeSync.setWindowContentHeight(desired);
      lastRequestedWindowHeight = desired;
    } catch (error) {
      // No-op: best effort window fitting.
    }
  });
}

function renderHistory(history) {
  historyBody.innerHTML = '';
  clearHistoryBtn.disabled = isBusy || history.length === 0;

  if (!history.length) {
    clearHistory('No syncs have been recorded yet.');
    return;
  }

  for (const item of history) {
    const files = normalizeHistoryFiles(item);
    for (const filePath of files) {
      const row = document.createElement('tr');

      const timeCol = document.createElement('td');
      timeCol.textContent = formatTimestamp(item.timestamp);

      const sourceCol = document.createElement('td');
      sourceCol.textContent = relativePathText(filePath.sourceRelativePath);

      const destinationCol = document.createElement('td');
      destinationCol.textContent = relativePathText(filePath.targetRelativePath);

      row.appendChild(timeCol);
      row.appendChild(sourceCol);
      row.appendChild(destinationCol);
      historyBody.appendChild(row);
    }
  }
  updateResultsPanelHeights();
}

clearHistoryBtn.addEventListener('click', async () => {
  if (!syncHistory.length || isBusy) {
    return;
  }

  setBusy(true);
  try {
    await window.treeSync.clearSyncHistory();
    syncHistory = [];
    renderHistory(syncHistory);
    setPlainStatus('Sync history cleared.');
  } catch (error) {
    setPlainStatus(`Failed to clear history: ${messageFromError(error, 'Unexpected error.')}`);
  } finally {
    setBusy(false);
  }
});

async function saveSelectedDirectories() {
  try {
    const result = await window.treeSync.setSelectedDirectories(
      leftPathInput.value.trim(),
      rightPathInput.value.trim()
    );
    if (result && result.warning) {
      setPlainStatus(`Warning: ${result.warning}`);
    }
  } catch (error) {
    setPlainStatus(`Warning: ${messageFromError(
      error,
      'Failed to save selected directories.'
    )}`);
  }
}

function renderResults(plan) {
  resultsBody.innerHTML = '';

  if (!plan.length) {
    clearResults('No files need syncing.');
    return;
  }

  for (const item of plan) {
    const row = document.createElement('tr');

    const sourceCol = document.createElement('td');
    sourceCol.textContent = relativePathText(item.sourceRelativePath);

    const targetCol = document.createElement('td');
    targetCol.textContent = relativePathText(item.targetRelativePath);

    const versionCol = document.createElement('td');
    versionCol.textContent = String(item.version);

    const sourceSizeCol = document.createElement('td');
    sourceSizeCol.textContent = formatSize(item.sourceSize);

    const destinationSizeCol = document.createElement('td');
    destinationSizeCol.textContent = item.destinationExists
      ? formatSize(item.destinationSize)
      : '(missing)';

    row.appendChild(sourceCol);
    row.appendChild(targetCol);
    row.appendChild(versionCol);
    row.appendChild(sourceSizeCol);
    row.appendChild(destinationSizeCol);

    resultsBody.appendChild(row);
  }
  updateResultsPanelHeights();
}

async function pickDirectory(inputEl) {
  const selected = await window.treeSync.pickDirectory(inputEl.value || undefined);
  if (selected) {
    inputEl.value = selected;
    await saveSelectedDirectories();
  }
}

pickLeftBtn.addEventListener('click', () => pickDirectory(leftPathInput));
pickRightBtn.addEventListener('click', () => pickDirectory(rightPathInput));

compareBtn.addEventListener('click', async () => {
  const leftRoot = leftPathInput.value.trim();
  const rightRoot = rightPathInput.value.trim();

  if (!leftRoot || !rightRoot) {
    setPlainStatus('Choose both directories before comparing.');
    return;
  }

  setBusy(true);
  setPlainStatus('Comparing directory trees...');
  progressBar.hidden = true;

  try {
    await saveSelectedDirectories();
    const result = await window.treeSync.compareTrees(leftRoot, rightRoot);
    currentPlan = result.plan;
    currentDirectoriesToCreate = Array.isArray(result.directoriesToCreate)
      ? result.directoriesToCreate
      : [];
    renderResults(currentPlan);

    if (currentPlan.length > 0) {
      const totalBytes = currentPlan.reduce((sum, item) => sum + (Number(item.sourceSize) || 0), 0);
      setPlainStatus(
        `Compare complete: ${currentPlan.length} file(s) will be copied/replaced ` +
        `(${formatBytesHuman(totalBytes)} total).`
      );
    } else {
      setPlainStatus('Compare complete: no files need syncing.');
    }
  } catch (error) {
    currentPlan = [];
    currentDirectoriesToCreate = [];
    clearResults('Comparison failed.');
    setPlainStatus(`Compare failed: ${messageFromError(error, 'Unexpected compare error.')}`);
  } finally {
    setBusy(false);
  }
});

syncBtn.addEventListener('click', async () => {
  if (!currentPlan.length) {
    setPlainStatus('Nothing to sync.');
    return;
  }

  if (currentDirectoriesToCreate.length > 0) {
    const folderList = currentDirectoriesToCreate.map((folder) => `- ${folder}`).join('\n');
    const proceed = window.confirm(
      `The following new folders will be created:\n\n${folderList}\n\nContinue with sync?`
    );
    if (!proceed) {
      setPlainStatus('Sync cancelled.');
      return;
    }
  }

  setBusy(true);
  smoothedThroughputBps = 0;
  progressBar.hidden = false;
  progressBar.value = 0;
  const plannedTotalBytes = currentPlan.reduce((sum, item) => sum + (Number(item.sourceSize) || 0), 0);
  progressBar.max = plannedTotalBytes > 0 ? plannedTotalBytes : 1;
  setPlainStatus(`Syncing ${currentPlan.length} file(s)...`);

  const stopListening = window.treeSync.onSyncProgress((progress) => {
    const totalBytes = Number(progress.totalBytes) || 0;
    const transferred = Number(progress.bytesTransferred) || 0;
    progressBar.max = totalBytes > 0 ? totalBytes : 1;
    progressBar.value = Math.min(transferred, progressBar.max);

    const displayIndex = Number.isFinite(progress.currentIndex)
      ? progress.currentIndex
      : Math.min(progress.completed + 1, progress.total);
    const speedText = Number.isFinite(progress.throughputBps)
      ? ` @ ${formatSpeed(progress.throughputBps)}`
      : '';
    const bytesText = totalBytes > 0
      ? ` (${formatBytesHuman(transferred)}/${formatBytesHuman(totalBytes)})`
      : '';

    const instantaneousBps = Number(progress.throughputBps) || 0;
    if (instantaneousBps > 0) {
      smoothedThroughputBps = smoothedThroughputBps > 0
        ? (smoothedThroughputBps * 0.7) + (instantaneousBps * 0.3)
        : instantaneousBps;
    }
    const remainingBytes = Math.max(0, totalBytes - transferred);
    const etaText = smoothedThroughputBps > 0 && remainingBytes > 0
      ? ` ETA ${formatEta(remainingBytes / smoothedThroughputBps)}`
      : '';
    if (progress.phase === 'copied' && progress.completed < progress.total) {
      return;
    }
    const leftText = `Syncing ${displayIndex}/${progress.total}: ${progress.targetRelativePath}`;
    const rightText = `${bytesText}${speedText}${etaText}`.trim();
    setSyncStatus(leftText, rightText);
  });

  try {
    const result = await window.treeSync.syncPlan(
      currentPlan,
      leftPathInput.value.trim(),
      rightPathInput.value.trim(),
      currentDirectoriesToCreate
    );
    currentPlan = [];
    currentDirectoriesToCreate = [];
    clearResults('Sync complete. Run compare again to refresh.');
    setPlainStatus(`Sync complete: ${result.copied} file(s) copied.`);
    if (result.warning) {
      setPlainStatus(`Sync complete with warning: ${result.warning}`);
    }
    if (result.logEntry) {
      syncHistory = [result.logEntry, ...syncHistory];
      renderHistory(syncHistory);
    }
  } catch (error) {
    setPlainStatus(`Sync failed: ${messageFromError(error, 'Unexpected sync error.')}`);
  } finally {
    stopListening();
    progressBar.hidden = true;
    smoothedThroughputBps = 0;
    setBusy(false);
  }
});

async function initializeFromPersistedState() {
  try {
    try {
      const limits = await window.treeSync.getWindowSizeLimits();
      if (limits && Number.isFinite(limits.maxContentHeight)) {
        maxContentHeightLimit = limits.maxContentHeight;
      }
    } catch (error) {
      maxContentHeightLimit = window.innerHeight;
    }

    const state = await window.treeSync.getAppState();
    const selectedDirs = state && state.selectedDirs ? state.selectedDirs : {};
    leftPathInput.value = selectedDirs.leftRoot || '';
    rightPathInput.value = selectedDirs.rightRoot || '';

    syncHistory = Array.isArray(state && state.syncHistory) ? state.syncHistory : [];
    renderHistory(syncHistory);
    updateResultsPanelHeights();
  } catch (error) {
    syncHistory = [];
    clearHistory('Failed to load sync history.');
    setPlainStatus(`Startup warning: ${error.message}`);
  }
}

initializeFromPersistedState();
updateResultsPanelHeights();
window.addEventListener('resize', updateResultsPanelHeights);
