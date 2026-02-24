const leftPathInput = document.getElementById('leftPath');
const rightPathInput = document.getElementById('rightPath');
const pickLeftBtn = document.getElementById('pickLeft');
const pickRightBtn = document.getElementById('pickRight');
const compareBtn = document.getElementById('compareBtn');
const syncBtn = document.getElementById('syncBtn');
const statusText = document.getElementById('statusText');
const resultsBody = document.getElementById('resultsBody');
const historyBody = document.getElementById('historyBody');
const progressBar = document.getElementById('progressBar');

let currentPlan = [];
let isBusy = false;
let syncHistory = [];

function setBusy(nextBusy) {
  isBusy = nextBusy;
  pickLeftBtn.disabled = nextBusy;
  pickRightBtn.disabled = nextBusy;
  compareBtn.disabled = nextBusy;
  syncBtn.disabled = nextBusy || currentPlan.length === 0;
}

function formatSize(bytes) {
  return Number(bytes).toLocaleString();
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
  cell.colSpan = 4;
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
  return parsed.toLocaleString();
}

function renderHistory(history) {
  historyBody.innerHTML = '';

  if (!history.length) {
    clearHistory('No syncs have been recorded yet.');
    return;
  }

  for (const item of history) {
    const row = document.createElement('tr');

    const timeCol = document.createElement('td');
    timeCol.textContent = formatTimestamp(item.timestamp);

    const leftCol = document.createElement('td');
    leftCol.textContent = item.leftRoot || '(not recorded)';

    const rightCol = document.createElement('td');
    rightCol.textContent = item.rightRoot || '(not recorded)';

    const copiedCol = document.createElement('td');
    copiedCol.textContent = `${item.copied}/${item.total}`;

    row.appendChild(timeCol);
    row.appendChild(leftCol);
    row.appendChild(rightCol);
    row.appendChild(copiedCol);
    historyBody.appendChild(row);
  }
}

async function saveSelectedDirectories() {
  await window.treeSync.setSelectedDirectories(leftPathInput.value.trim(), rightPathInput.value.trim());
}

function renderResults(plan) {
  resultsBody.innerHTML = '';

  if (!plan.length) {
    clearResults('No files need syncing.');
    return;
  }

  for (const item of plan) {
    const row = document.createElement('tr');

    const targetCol = document.createElement('td');
    targetCol.textContent = item.targetRelativePath;

    const sourceCol = document.createElement('td');
    sourceCol.textContent = item.sourceRelativePath;

    const versionCol = document.createElement('td');
    versionCol.textContent = String(item.version);

    const sourceSizeCol = document.createElement('td');
    sourceSizeCol.textContent = formatSize(item.sourceSize);

    const destinationSizeCol = document.createElement('td');
    destinationSizeCol.textContent = item.destinationExists
      ? formatSize(item.destinationSize)
      : '(missing)';

    row.appendChild(targetCol);
    row.appendChild(sourceCol);
    row.appendChild(versionCol);
    row.appendChild(sourceSizeCol);
    row.appendChild(destinationSizeCol);

    resultsBody.appendChild(row);
  }
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
    statusText.textContent = 'Choose both directories before comparing.';
    return;
  }

  setBusy(true);
  statusText.textContent = 'Comparing directory trees...';
  progressBar.hidden = true;

  try {
    await saveSelectedDirectories();
    const result = await window.treeSync.compareTrees(leftRoot, rightRoot);
    currentPlan = result.plan;
    renderResults(currentPlan);

    if (currentPlan.length > 0) {
      statusText.textContent = `Compare complete: ${currentPlan.length} file(s) will be copied/replaced.`;
    } else {
      statusText.textContent = 'Compare complete: no files need syncing.';
    }
  } catch (error) {
    currentPlan = [];
    clearResults('Comparison failed.');
    statusText.textContent = `Compare failed: ${error.message}`;
  } finally {
    setBusy(false);
  }
});

syncBtn.addEventListener('click', async () => {
  if (!currentPlan.length) {
    statusText.textContent = 'Nothing to sync.';
    return;
  }

  setBusy(true);
  progressBar.hidden = false;
  progressBar.value = 0;
  progressBar.max = currentPlan.length;
  statusText.textContent = `Syncing ${currentPlan.length} file(s)...`;

  const stopListening = window.treeSync.onSyncProgress((progress) => {
    progressBar.max = progress.total;
    progressBar.value = progress.completed;
    statusText.textContent = `Syncing ${progress.completed}/${progress.total}: ${progress.targetRelativePath}`;
  });

  try {
    const result = await window.treeSync.syncPlan(
      currentPlan,
      leftPathInput.value.trim(),
      rightPathInput.value.trim()
    );
    currentPlan = [];
    clearResults('Sync complete. Run compare again to refresh.');
    statusText.textContent = `Sync complete: ${result.copied} file(s) copied.`;
    if (result.logEntry) {
      syncHistory = [result.logEntry, ...syncHistory];
      renderHistory(syncHistory);
    }
  } catch (error) {
    statusText.textContent = `Sync failed: ${error.message}`;
  } finally {
    stopListening();
    progressBar.hidden = true;
    setBusy(false);
  }
});

async function initializeFromPersistedState() {
  try {
    const state = await window.treeSync.getAppState();
    const selectedDirs = state && state.selectedDirs ? state.selectedDirs : {};
    leftPathInput.value = selectedDirs.leftRoot || '';
    rightPathInput.value = selectedDirs.rightRoot || '';

    syncHistory = Array.isArray(state && state.syncHistory) ? state.syncHistory : [];
    renderHistory(syncHistory);
  } catch (error) {
    syncHistory = [];
    clearHistory('Failed to load sync history.');
    statusText.textContent = `Startup warning: ${error.message}`;
  }
}

initializeFromPersistedState();
