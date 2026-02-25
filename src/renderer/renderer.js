const leftPathInput = document.getElementById('leftPath');
const rightPathInput = document.getElementById('rightPath');
const pickLeftBtn = document.getElementById('pickLeft');
const pickRightBtn = document.getElementById('pickRight');
const leftPathDropTarget = leftPathInput.closest('.path-input-wrap');
const rightPathDropTarget = rightPathInput.closest('.path-input-wrap');
const compareBtn = document.getElementById('compareBtn');
const syncBtn = document.getElementById('syncBtn');
const pauseBtn = document.getElementById('pauseBtn');
const statusText = document.getElementById('statusText');
const syncReport = document.getElementById('syncReport');
const resultsBody = document.getElementById('resultsBody');
const historyBody = document.getElementById('historyBody');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const progressBar = document.getElementById('progressBar');
const resultPanels = Array.from(document.querySelectorAll('.results'));
const appRoot = document.querySelector('.app');
const folderCreateModal = document.getElementById('folderCreateModal');
const folderCreateList = document.getElementById('folderCreateList');
const folderCreateMessage = document.getElementById('folderCreateMessage');
const confirmFolderCreateBtn = document.getElementById('confirmFolderCreateBtn');
const cancelFolderCreateBtn = document.getElementById('cancelFolderCreateBtn');

let currentPlan = [];
let currentDirectoriesToCreate = [];
let currentCompareToken = '';
let isBusy = false;
let isSyncing = false;
let isCancellingSync = false;
let isPaused = false;
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

function setSyncReport(message) {
  const text = String(message || '').trim();
  syncReport.hidden = text.length === 0;
  syncReport.textContent = text;
  queueWindowHeightUpdate();
}

function updateControlStates() {
  pickLeftBtn.disabled = isBusy;
  pickRightBtn.disabled = isBusy;
  compareBtn.disabled = isBusy;

  if (isSyncing) {
    syncBtn.textContent = isCancellingSync ? 'Cancelling...' : 'Cancel';
    syncBtn.disabled = isCancellingSync;
  } else {
    syncBtn.textContent = 'Sync';
    syncBtn.disabled = isBusy || currentPlan.length === 0;
  }

  pauseBtn.hidden = !isSyncing;
  pauseBtn.disabled = !isSyncing || isCancellingSync;
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';

  clearHistoryBtn.disabled = isBusy || syncHistory.length === 0;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  updateControlStates();
}

function setSyncState(nextSyncing, paused = false) {
  isSyncing = nextSyncing;
  isPaused = nextSyncing ? paused : false;
  if (!nextSyncing) {
    isCancellingSync = false;
  }
  updateControlStates();
}

function invalidateCompareState(statusMessage) {
  currentPlan = [];
  currentDirectoriesToCreate = [];
  currentCompareToken = '';
  clearResults('Comparison is out of date. Run compare again.');
  if (typeof statusMessage === 'string' && statusMessage.trim()) {
    setPlainStatus(statusMessage);
  }
  updateControlStates();
}

function setPlainStatus(message) {
  statusText.classList.remove('sync-live');
  statusText.textContent = message;
  queueWindowHeightUpdate();
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
  queueWindowHeightUpdate();
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

function promptForFolderCreation(directoriesToCreate) {
  if (!folderCreateModal || !folderCreateList || !confirmFolderCreateBtn || !cancelFolderCreateBtn) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const folderList = directoriesToCreate.map((folder) => '- ' + folder).join('\n');
    folderCreateList.textContent = folderList || '(none)';
    if (folderCreateMessage) {
      folderCreateMessage.textContent = directoriesToCreate.length + ' folder(s) will be created at destination.';
    }

    folderCreateModal.hidden = false;

    const cleanup = () => {
      folderCreateModal.hidden = true;
      confirmFolderCreateBtn.removeEventListener('click', onConfirm);
      cancelFolderCreateBtn.removeEventListener('click', onCancel);
      folderCreateModal.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeydown);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const onBackdropClick = (event) => {
      if (event.target === folderCreateModal) {
        onCancel();
      }
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };

    confirmFolderCreateBtn.addEventListener('click', onConfirm);
    cancelFolderCreateBtn.addEventListener('click', onCancel);
    folderCreateModal.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeydown);

    confirmFolderCreateBtn.focus();
  });
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
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
  if (!appRoot || resultPanels.length === 0) {
    return;
  }

  const appStyle = window.getComputedStyle(appRoot);
  const appBottomPadding = Number.parseFloat(appStyle.paddingBottom) || 0;

  const firstPanelTop = resultPanels[0].getBoundingClientRect().top;
  const heightBudget = Math.max(320, maxContentHeightLimit);
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
    if (!appRoot) {
      return;
    }

    const appRect = appRoot.getBoundingClientRect();
    const desired = Math.ceil(appRect.height);
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
  updateControlStates();

  if (!history.length) {
    clearHistory('No syncs have been recorded yet.');
    updateResultsPanelHeights();
    return;
  }

  for (const item of history) {
    const files = normalizeHistoryFiles(item);
    for (const filePath of files) {
      const row = document.createElement('tr');

      const timeCol = document.createElement('td');
      timeCol.textContent = formatTimestamp(item.timestamp);

      const sourceCol = document.createElement('td');
      sourceCol.className = 'tail-ellipsis';
      sourceCol.textContent = relativePathText(filePath.sourceRelativePath);

      const destinationCol = document.createElement('td');
      destinationCol.className = 'tail-ellipsis';
      destinationCol.textContent = relativePathText(filePath.targetRelativePath);

      row.appendChild(timeCol);
      row.appendChild(sourceCol);
      row.appendChild(destinationCol);
      historyBody.appendChild(row);
    }
  }
  updateResultsPanelHeights();
}

function formatSyncSummary(result) {
  const status = result && result.status ? result.status : 'completed';
  const copied = Number(result.copied) || 0;
  const total = Number(result.total) || 0;
  const failed = Array.isArray(result.failed) ? result.failed.length : 0;
  const bytes = Number(result.bytesCopied) || 0;
  const totalBytes = Number(result.totalBytes) || 0;
  const duration = formatDuration(result.durationMs);
  const avg = formatSpeed(result.averageThroughputBps);

  const lines = [];
  if (status === 'cancelled') {
    lines.push(`Outcome: Cancelled - ${result.errorMessage || 'Cancelled by user.'}`);
  } else if (status === 'error') {
    lines.push(`Outcome: Error - ${result.errorMessage || 'Sync failed.'}`);
  } else {
    lines.push('Outcome: Completed');
  }

  lines.push(`Summary: copied ${copied}/${total}, failed ${failed}`);
  lines.push(`Bytes: ${formatBytesHuman(bytes)} / ${formatBytesHuman(totalBytes)}`);
  lines.push(`Duration: ${duration}, average: ${avg}`);

  const succeeded = Array.isArray(result.succeededFiles) ? result.succeededFiles : [];
  if (succeeded.length > 0) {
    lines.push('');
    lines.push('Successfully transferred files:');
    const shown = succeeded.slice(0, 25);
    for (const item of shown) {
      lines.push(`- ${item.targetRelativePath || item.sourceRelativePath || '(unknown)'}`);
    }
    if (succeeded.length > shown.length) {
      lines.push(`...and ${succeeded.length - shown.length} more`);
    }
  }

  if (failed > 0) {
    lines.push('');
    lines.push('Failed files:');
    const failures = result.failed.slice(0, 25);
    for (const failure of failures) {
      const target = failure && failure.targetRelativePath ? failure.targetRelativePath : '(unknown)';
      const msg = failure && failure.message ? failure.message : 'Unknown error';
      lines.push(`- ${target}: ${msg}`);
    }
    if (result.failed.length > failures.length) {
      lines.push(`...and ${result.failed.length - failures.length} more`);
    }
  }

  if (result.warning) {
    lines.push('');
    lines.push(`Warning: ${result.warning}`);
  }

  return lines.join('\n');
}

function renderResults(plan) {
  resultsBody.innerHTML = '';

  if (!plan.length) {
    clearResults('No files need syncing.');
    updateResultsPanelHeights();
    return;
  }

  for (const item of plan) {
    const row = document.createElement('tr');

    const sourceCol = document.createElement('td');
    sourceCol.className = 'tail-ellipsis';
    sourceCol.textContent = relativePathText(item.sourceRelativePath);

    const targetCol = document.createElement('td');
    targetCol.className = 'tail-ellipsis';
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

function applySyncProgress(progress) {
  const totalBytes = Number(progress.totalBytes) || 0;
  const transferred = Number(progress.bytesTransferred) || 0;
  const failedCount = Number(progress.failed) || 0;

  progressBar.max = totalBytes > 0 ? totalBytes : 1;
  progressBar.value = Math.min(transferred, progressBar.max);

  const instantaneousBps = Number(progress.throughputBps) || 0;
  if (instantaneousBps > 0) {
    smoothedThroughputBps = smoothedThroughputBps > 0
      ? (smoothedThroughputBps * 0.7) + (instantaneousBps * 0.3)
      : instantaneousBps;
  }

  const activeCount = Number(progress.activeCount) || 0;
  const completed = Number(progress.completed) || 0;
  const total = Number(progress.total) || 0;
  const currentIndex = Number(progress.currentIndex) || 0;
  const displayIndex = Math.max(
    currentIndex,
    Math.min(total, completed + failedCount + (activeCount > 0 ? 1 : 0))
  );

  isPaused = Boolean(progress.isPaused);
  updateControlStates();

  const remainingBytes = Math.max(0, totalBytes - transferred);
  const etaText = (!isPaused && smoothedThroughputBps > 0 && remainingBytes > 0)
    ? ` ETA ${formatEta(remainingBytes / smoothedThroughputBps)}`
    : '';

  const bytesText = totalBytes > 0
    ? `(${formatBytesHuman(transferred)}/${formatBytesHuman(totalBytes)})`
    : '';
  const speedText = !isPaused && smoothedThroughputBps > 0
    ? ` @ ${formatSpeed(smoothedThroughputBps)}`
    : '';
  const failText = failedCount > 0 ? ` Failed ${failedCount}` : '';
  const pauseText = isPaused ? ' Paused' : '';

  const activeText = activeCount > 1 ? ` (${activeCount} active)` : '';
  const target = progress.targetRelativePath || '(preparing)';
  const leftText = `Syncing ${displayIndex}/${total}${activeText}: ${target}`;
  const rightText = `${bytesText}${speedText}${etaText}${failText}${pauseText}`.trim();

  setSyncStatus(leftText, rightText);
}

async function compareDirectories(leftRoot, rightRoot) {
  const result = await window.treeSync.compareTrees(leftRoot, rightRoot);
  if (!result || typeof result !== 'object' || typeof result.compareToken !== 'string') {
    throw new Error('Invalid compare response from main process.');
  }

  currentPlan = Array.isArray(result.plan) ? result.plan : [];
  currentDirectoriesToCreate = Array.isArray(result.directoriesToCreate)
    ? result.directoriesToCreate
    : [];
  currentCompareToken = result.compareToken;
  renderResults(currentPlan);
  return result;
}

async function pickDirectory(inputEl) {
  const previous = inputEl.value.trim();
  const selected = await window.treeSync.pickDirectory(inputEl.value || undefined);
  if (selected) {
    inputEl.value = selected;
    if (selected.trim() !== previous) {
      invalidateCompareState('Directory changed. Run compare again.');
    }
    await saveSelectedDirectories();
  }
}

function hasFilePayload(event) {
  const dataTransfer = event && event.dataTransfer;
  if (!dataTransfer) {
    return false;
  }

  const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return true;
  }

  return types.includes('Files') || types.includes('text/uri-list') || types.includes('public.file-url');
}

function decodePlainDroppedPath(rawValue) {
  const candidate = String(rawValue || '').trim();
  if (!candidate) {
    return null;
  }

  const line = candidate
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('#'));

  if (!line) {
    return null;
  }

  const unquoted = line.replace(/^"(.*)"$/, '$1').trim();
  if (/^\//.test(unquoted) || /^[A-Za-z]:[\\/]/.test(unquoted)) {
    return unquoted;
  }

  return null;
}

function decodeDroppedFileUrl(rawValue) {
  const candidate = String(rawValue || '').trim();
  if (!candidate) {
    return null;
  }

  const line = candidate
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('#'));

  if (!line || !/^file:/i.test(line)) {
    return null;
  }

  try {
    const parsed = new URL(line);
    if (parsed.protocol !== 'file:') {
      return null;
    }

    let pathname = decodeURIComponent(parsed.pathname || '');
    if (!pathname) {
      return null;
    }

    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }

    return pathname;
  } catch (_error) {
    return null;
  }
}

async function extractDroppedPath(event) {
  const dataTransfer = event && event.dataTransfer;
  if (!dataTransfer) {
    return null;
  }

  const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  for (const file of files) {
    if (file && typeof file.path === 'string' && file.path.trim()) {
      return file.path.trim();
    }

    if (file && window.treeSync && typeof window.treeSync.getPathForFile === 'function') {
      const resolved = window.treeSync.getPathForFile(file);
      if (typeof resolved === 'string' && resolved.trim()) {
        return resolved.trim();
      }
    }
  }

  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (!item || item.kind !== 'file' || typeof item.getAsFile !== 'function') {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    if (typeof file.path === 'string' && file.path.trim()) {
      return file.path.trim();
    }

    if (window.treeSync && typeof window.treeSync.getPathForFile === 'function') {
      const resolved = window.treeSync.getPathForFile(file);
      if (typeof resolved === 'string' && resolved.trim()) {
        return resolved.trim();
      }
    }
  }

  const uriPayload =
    dataTransfer.getData('text/uri-list') ||
    dataTransfer.getData('public.file-url') ||
    dataTransfer.getData('text/plain');

  const decodedUriPath = decodeDroppedFileUrl(uriPayload);
  if (decodedUriPath) {
    return decodedUriPath;
  }

  const decodedPlainPath = decodePlainDroppedPath(uriPayload);
  if (decodedPlainPath) {
    return decodedPlainPath;
  }

  return null;
}

async function setDirectoryFromDrop(inputEl, droppedPath, label) {
  const previous = inputEl.value.trim();

  let validation;
  try {
    validation = await window.treeSync.validateDirectoryPath(droppedPath);
  } catch (error) {
    setPlainStatus(label + ' drop failed: ' + messageFromError(error, 'Unexpected validation error.'));
    return;
  }

  if (!validation || !validation.ok) {
    const reason = validation && validation.error ? validation.error : 'Dropped item must be a directory.';
    setPlainStatus(label + ' drop rejected: ' + reason);
    return;
  }

  inputEl.value = validation.path || droppedPath;
  if (inputEl.value.trim() !== previous) {
    invalidateCompareState('Directory changed. Run compare again.');
  }

  await saveSelectedDirectories();
  setPlainStatus(label + ' directory set from drag and drop.');
}

function attachDirectoryDropHandlers(targetEl, inputEl, label) {
  if (!targetEl) {
    return;
  }

  let dragDepth = 0;

  const clearDropState = () => {
    dragDepth = 0;
    targetEl.classList.remove('drop-active');
  };

  targetEl.addEventListener('dragenter', (event) => {
    if (!hasFilePayload(event) || isBusy) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    targetEl.classList.add('drop-active');
  });

  targetEl.addEventListener('dragover', (event) => {
    if (!hasFilePayload(event) || isBusy) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    targetEl.classList.add('drop-active');
  });

  targetEl.addEventListener('dragleave', () => {
    if (dragDepth > 0) {
      dragDepth -= 1;
    }
    if (dragDepth <= 0) {
      clearDropState();
    }
  });

  targetEl.addEventListener('drop', async (event) => {
    if (!hasFilePayload(event)) {
      clearDropState();
      return;
    }

    event.preventDefault();
    clearDropState();

    if (isBusy) {
      setPlainStatus('Wait for the current operation to finish before changing directories.');
      return;
    }

    const droppedPath = await extractDroppedPath(event);
    if (!droppedPath) {
      setPlainStatus(label + ' drop rejected: no directory path found.');
      return;
    }

    await setDirectoryFromDrop(inputEl, droppedPath, label);
  });
}

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

async function refreshCompareAfterSync(result) {
  const leftRoot = leftPathInput.value.trim();
  const rightRoot = rightPathInput.value.trim();

  let outcomeText = 'Sync complete.';
  if (result.status === 'cancelled') {
    outcomeText = `Sync cancelled: ${result.errorMessage || 'Cancelled by user.'}`;
  } else if (result.status === 'error') {
    outcomeText = `Sync error: ${result.errorMessage || 'Unexpected sync error.'}`;
  } else if (result.warning) {
    outcomeText = `Sync complete with warning: ${result.warning}`;
  }

  if (!leftRoot || !rightRoot) {
    setPlainStatus(outcomeText);
    return;
  }

  try {
    await compareDirectories(leftRoot, rightRoot);
    if (currentPlan.length > 0) {
      const totalBytes = currentPlan.reduce((sum, item) => sum + (Number(item.sourceSize) || 0), 0);
      setPlainStatus(
        `${outcomeText} Compare refreshed: ${currentPlan.length} file(s) still pending ` +
        `(${formatBytesHuman(totalBytes)} total).`
      );
    } else {
      setPlainStatus(`${outcomeText} Compare refreshed: no files need syncing.`);
    }
  } catch (error) {
    invalidateCompareState();
    clearResults('Comparison failed.');
    setPlainStatus(
      `${outcomeText} Compare refresh failed: ${messageFromError(error, 'Unexpected compare error.')}`
    );
  }
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

pickLeftBtn.addEventListener('click', () => pickDirectory(leftPathInput));
pickRightBtn.addEventListener('click', () => pickDirectory(rightPathInput));

leftPathInput.addEventListener('change', async () => {
  invalidateCompareState('Directory changed. Run compare again.');
  await saveSelectedDirectories();
});

rightPathInput.addEventListener('change', async () => {
  invalidateCompareState('Directory changed. Run compare again.');
  await saveSelectedDirectories();
});

attachDirectoryDropHandlers(leftPathDropTarget, leftPathInput, 'Source');
attachDirectoryDropHandlers(rightPathDropTarget, rightPathInput, 'Destination');

document.addEventListener('dragover', (event) => {
  if (hasFilePayload(event)) {
    event.preventDefault();
  }
});

document.addEventListener('drop', (event) => {
  if (hasFilePayload(event)) {
    event.preventDefault();
  }
});

document.addEventListener('keydown', async (event) => {
  const key = String(event.key || '').toLowerCase();
  if (key !== 'c' || (!event.metaKey && !event.ctrlKey) || event.altKey) {
    return;
  }

  const focusedSelection = getFocusedSelectionText();
  if (focusedSelection) {
    try {
      await window.treeSync.copyText(focusedSelection);
      event.preventDefault();
      return;
    } catch (_error) {
      return;
    }
  }

  const active = document.activeElement;
  if (active && active.isContentEditable) {
    return;
  }

  const copied = await copySelectionToClipboard();
  if (copied) {
    event.preventDefault();
  }
});

compareBtn.addEventListener('click', async () => {
  const leftRoot = leftPathInput.value.trim();
  const rightRoot = rightPathInput.value.trim();

  if (!leftRoot || !rightRoot) {
    setPlainStatus('Choose both directories before comparing.');
    return;
  }

  setBusy(true);
  setSyncReport('');
  setPlainStatus('Comparing directory trees...');
  progressBar.hidden = true;

  try {
    await saveSelectedDirectories();
    await compareDirectories(leftRoot, rightRoot);

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
    invalidateCompareState();
    clearResults('Comparison failed.');
    setPlainStatus(`Compare failed: ${messageFromError(error, 'Unexpected compare error.')}`);
  } finally {
    setBusy(false);
  }
});

async function runSyncOperation(executeSyncPromiseFactory) {
  setBusy(true);
  setSyncState(true, false);
  setSyncReport('');
  smoothedThroughputBps = 0;
  progressBar.hidden = false;
  progressBar.value = 0;

  const stopListening = window.treeSync.onSyncProgress((progress) => {
    applySyncProgress(progress || {});
  });

  try {
    const result = await executeSyncPromiseFactory();

    if (result.logEntry) {
      syncHistory = [result.logEntry, ...syncHistory];
      renderHistory(syncHistory);
    }

    setSyncReport(formatSyncSummary(result));
    await refreshCompareAfterSync(result);
  } catch (error) {
    const message = messageFromError(error, 'Unexpected sync error.');
    setPlainStatus(`Sync failed: ${message}`);
    setSyncReport(`Outcome: Error - ${message}`);
  } finally {
    stopListening();
    progressBar.hidden = true;
    smoothedThroughputBps = 0;
    setSyncState(false, false);
    setBusy(false);
  }
}

pauseBtn.addEventListener('click', async () => {
  if (!isSyncing || isCancellingSync) {
    return;
  }

  try {
    const state = await window.treeSync.toggleSyncPause();
    if (state && state.active) {
      isPaused = Boolean(state.paused);
      updateControlStates();
      setPlainStatus(isPaused ? 'Sync paused.' : 'Sync resumed.');
    }
  } catch (error) {
    setPlainStatus(`Pause toggle failed: ${messageFromError(error, 'Unexpected pause error.')}`);
  }
});

syncBtn.addEventListener('click', async () => {
  if (isSyncing) {
    if (isCancellingSync) {
      return;
    }

    isCancellingSync = true;
    updateControlStates();
    setPlainStatus('Cancelling sync...');

    try {
      await window.treeSync.cancelSync();
    } catch (error) {
      isCancellingSync = false;
      updateControlStates();
      setPlainStatus(`Cancel request failed: ${messageFromError(error, 'Unexpected cancel error.')}`);
    }
    return;
  }

  if (!currentPlan.length) {
    setPlainStatus('Nothing to sync.');
    return;
  }

  if (!currentCompareToken) {
    setPlainStatus('Compare is out of date. Run compare again before syncing.');
    return;
  }

  if (currentDirectoriesToCreate.length > 0) {
    const proceed = await promptForFolderCreation(currentDirectoriesToCreate);
    if (!proceed) {
      setPlainStatus('Sync cancelled.');
      return;
    }
  }

  const plannedTotalBytes = currentPlan.reduce((sum, item) => sum + (Number(item.sourceSize) || 0), 0);
  progressBar.max = plannedTotalBytes > 0 ? plannedTotalBytes : 1;

  await runSyncOperation(async () => {
    setPlainStatus(`Syncing ${currentPlan.length} file(s)...`);
    return window.treeSync.syncPlan(
      currentPlan,
      leftPathInput.value.trim(),
      rightPathInput.value.trim(),
      currentDirectoriesToCreate,
      currentCompareToken
    );
  });
});

function getFocusedSelectionText() {
  const active = document.activeElement;
  if (!active) {
    return '';
  }

  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
    const value = typeof active.value === 'string' ? active.value : '';
    const start = Number.isInteger(active.selectionStart) ? active.selectionStart : 0;
    const end = Number.isInteger(active.selectionEnd) ? active.selectionEnd : start;
    if (end > start) {
      return value.slice(start, end);
    }
  }

  return '';
}

function getSelectedText() {
  if (window.getSelection) {
    return String(window.getSelection() || '').trim();
  }
  return '';
}

async function copySelectionToClipboard() {
  const selectedText = getSelectedText();
  if (!selectedText) {
    return false;
  }

  try {
    await window.treeSync.copyText(selectedText);
    return true;
  } catch (_error) {
    return false;
  }
}

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

updateControlStates();
initializeFromPersistedState();
updateResultsPanelHeights();

if (appRoot && typeof ResizeObserver !== 'undefined') {
  const resizeObserver = new ResizeObserver(() => {
    updateResultsPanelHeights();
  });
  resizeObserver.observe(appRoot);
}

window.addEventListener('resize', updateResultsPanelHeights);
