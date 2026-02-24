const fs = require('fs/promises');
const path = require('path');

const DEFAULT_STATE = {
  selectedDirs: {
    leftRoot: '',
    rightRoot: '',
  },
  syncHistory: [],
};

const MAX_HISTORY_ITEMS = 200;

function normalizeState(state) {
  const selected = state && state.selectedDirs ? state.selectedDirs : {};
  const history = Array.isArray(state && state.syncHistory) ? state.syncHistory : [];

  return {
    selectedDirs: {
      leftRoot: typeof selected.leftRoot === 'string' ? selected.leftRoot : '',
      rightRoot: typeof selected.rightRoot === 'string' ? selected.rightRoot : '',
    },
    syncHistory: history.slice(0, MAX_HISTORY_ITEMS),
  };
}

async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState({
      selectedDirs: parsed && parsed.selectedDirs ? parsed.selectedDirs : {},
      syncHistory: [],
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...DEFAULT_STATE };
    }
    throw error;
  }
}

async function saveState(filePath, state) {
  const normalized = normalizeState(state);
  const persistable = {
    selectedDirs: normalized.selectedDirs,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(persistable, null, 2), 'utf8');
  return normalized;
}

function updateSelectedDirs(state, partialSelectedDirs) {
  const next = normalizeState(state);
  if (typeof partialSelectedDirs.leftRoot === 'string') {
    next.selectedDirs.leftRoot = partialSelectedDirs.leftRoot;
  }
  if (typeof partialSelectedDirs.rightRoot === 'string') {
    next.selectedDirs.rightRoot = partialSelectedDirs.rightRoot;
  }
  return next;
}

function appendSyncHistory(state, historyItem) {
  const next = normalizeState(state);
  const entry = {
    id: typeof historyItem.id === 'string' ? historyItem.id : `${Date.now()}`,
    timestamp: typeof historyItem.timestamp === 'string' ? historyItem.timestamp : new Date().toISOString(),
    leftRoot: typeof historyItem.leftRoot === 'string' ? historyItem.leftRoot : '',
    rightRoot: typeof historyItem.rightRoot === 'string' ? historyItem.rightRoot : '',
    copied: Number(historyItem.copied) || 0,
    total: Number(historyItem.total) || 0,
    files: Array.isArray(historyItem.files)
      ? historyItem.files
          .map((value) => {
            if (typeof value === 'string') {
              return {
                sourceRelativePath: '',
                targetRelativePath: value,
              };
            }
            if (!value || typeof value !== 'object') {
              return null;
            }
            return {
              sourceRelativePath:
                typeof value.sourceRelativePath === 'string' ? value.sourceRelativePath : '',
              targetRelativePath:
                typeof value.targetRelativePath === 'string' ? value.targetRelativePath : '',
            };
          })
          .filter((value) => value && (value.sourceRelativePath || value.targetRelativePath))
          .slice(0, 1000)
      : [],
  };

  next.syncHistory = [entry, ...next.syncHistory].slice(0, MAX_HISTORY_ITEMS);
  return { nextState: next, entry };
}

function clearSyncHistory(state) {
  const next = normalizeState(state);
  next.syncHistory = [];
  return next;
}

module.exports = {
  loadState,
  saveState,
  normalizeState,
  updateSelectedDirs,
  appendSyncHistory,
  clearSyncHistory,
};
