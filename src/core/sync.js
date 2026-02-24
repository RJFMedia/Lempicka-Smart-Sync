const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const IGNORED_FILE_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  'icon\r',
  'sync-history.log',
]);

const RECOVERABLE_FS_CODES = new Set([
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EIO',
  'ENOENT',
  'ENOTCONN',
  'EAGAIN',
  'ETIMEDOUT',
]);

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const DEFAULT_SMALL_FILE_THRESHOLD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PARALLEL_SMALL_FILES = 3;
const PAUSE_POLL_MS = 120;

class TreeSyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TreeSyncError';
    this.code = code;
    this.details = details;
  }
}

function filesystemHint(error) {
  switch (error && error.code) {
    case 'ENOENT':
      return 'Path is unavailable (missing or disconnected).';
    case 'ENOSPC':
      return 'No space left on destination device.';
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied.';
    case 'EROFS':
      return 'Destination is read-only.';
    case 'ENOTDIR':
      return 'A path component is not a directory.';
    case 'EMFILE':
    case 'ENFILE':
      return 'Too many open files.';
    default:
      return error && error.message ? error.message : 'Unknown filesystem error.';
  }
}

function wrapFilesystemError(action, targetPath, error, details = {}) {
  return new TreeSyncError(
    'FILESYSTEM_ERROR',
    `${action} failed for "${targetPath}": ${filesystemHint(error)}`,
    {
      ...details,
      targetPath,
      fsCode: error && error.code ? error.code : 'UNKNOWN',
    }
  );
}

async function ensureDirectoryAvailable(rootPath, accessMode, label) {
  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      throw new TreeSyncError(
        'INVALID_DIRECTORY',
        `${label} is not a directory: "${rootPath}".`,
        { path: rootPath, label }
      );
    }
    await fs.access(rootPath, accessMode);
  } catch (error) {
    if (error instanceof TreeSyncError) {
      throw error;
    }
    throw wrapFilesystemError(`Accessing ${label}`, rootPath, error, { label });
  }
}

function isHiddenName(name) {
  return typeof name === 'string' && name.startsWith('.');
}

function isLikelySystemFile(name) {
  return IGNORED_FILE_NAMES.has(String(name || '').toLowerCase());
}

function hasNormalExtension(fileName) {
  const ext = path.extname(fileName);
  return ext.length > 1;
}

function localTimestampString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

let setFileAvailability = null;

async function hasMacSetFile() {
  if (process.platform !== 'darwin') {
    return false;
  }
  if (setFileAvailability !== null) {
    return setFileAvailability;
  }
  try {
    await fs.access('/usr/bin/SetFile', fsConstants.X_OK);
    setFileAvailability = true;
  } catch (error) {
    setFileAvailability = false;
  }
  return setFileAvailability;
}

function formatSetFileDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear());
  let hour = date.getHours();
  const amPm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${month}/${day}/${year} ${String(hour).padStart(2, '0')}:${minute}:${second} ${amPm}`;
}

async function tryPreserveCreationDate(sourcePath, targetPath) {
  if (!(await hasMacSetFile())) {
    return;
  }

  let sourceStat;
  try {
    sourceStat = await fs.stat(sourcePath);
  } catch (error) {
    return;
  }

  if (!sourceStat || !Number.isFinite(sourceStat.birthtimeMs) || sourceStat.birthtimeMs <= 0) {
    return;
  }

  try {
    const formatted = formatSetFileDate(sourceStat.birthtime);
    await execFileAsync('/usr/bin/SetFile', ['-d', formatted, targetPath]);
  } catch (error) {
    // Best effort only. Sync should not fail if creation date cannot be preserved.
  }
}

function shouldCancelRequested(shouldCancel) {
  return typeof shouldCancel === 'function' && Boolean(shouldCancel());
}

function shouldPauseRequested(shouldPause) {
  return typeof shouldPause === 'function' && Boolean(shouldPause());
}

function makeSyncCancelledError(details = {}) {
  return new TreeSyncError('SYNC_CANCELLED', 'Sync cancelled by user.', details);
}

function isSyncCancelledError(error) {
  return error instanceof TreeSyncError && error.code === 'SYNC_CANCELLED';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUnpaused(shouldPause, shouldCancel, onPauseTick) {
  while (shouldPauseRequested(shouldPause)) {
    if (shouldCancelRequested(shouldCancel)) {
      throw makeSyncCancelledError();
    }
    if (typeof onPauseTick === 'function') {
      await onPauseTick();
    }
    await sleep(PAUSE_POLL_MS);
  }
}

function isRecoverableFilesystemError(error) {
  if (!error || !error.code) {
    return false;
  }
  return RECOVERABLE_FS_CODES.has(error.code);
}

function computeRetryDelayMs(baseDelayMs, attemptIndex) {
  const base = Math.max(50, Number(baseDelayMs) || DEFAULT_RETRY_BASE_DELAY_MS);
  return base * (2 ** attemptIndex);
}

async function withRetry(run, options = {}) {
  const {
    retries = DEFAULT_RETRY_COUNT,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    shouldCancel,
    shouldPause,
    onRetry,
  } = options;

  const maxRetries = Math.max(0, Number(retries) || 0);
  let attempt = 0;

  while (true) {
    if (shouldCancelRequested(shouldCancel)) {
      throw makeSyncCancelledError();
    }

    await waitForUnpaused(shouldPause, shouldCancel);

    try {
      return await run(attempt);
    } catch (error) {
      if (isSyncCancelledError(error) || shouldCancelRequested(shouldCancel)) {
        throw makeSyncCancelledError();
      }

      if (!isRecoverableFilesystemError(error) || attempt >= maxRetries) {
        throw error;
      }

      const retryDelayMs = computeRetryDelayMs(baseDelayMs, attempt);
      if (typeof onRetry === 'function') {
        await onRetry({ attempt: attempt + 1, retryDelayMs, error });
      }
      attempt += 1;
      await sleep(retryDelayMs);
    }
  }
}

async function copyFileWithProgress(sourcePath, targetPath, onChunk, options = {}) {
  const {
    writeFlags = 'w',
    shouldCancel,
    shouldPause,
    onPauseTick,
  } = options;

  const bufferSize = 256 * 1024;
  const buffer = Buffer.allocUnsafe(bufferSize);
  const sourceHandle = await fs.open(sourcePath, 'r');
  const targetHandle = await fs.open(targetPath, writeFlags);

  try {
    let position = 0;
    while (true) {
      if (shouldCancelRequested(shouldCancel)) {
        throw makeSyncCancelledError();
      }

      await waitForUnpaused(shouldPause, shouldCancel, onPauseTick);

      const readResult = await sourceHandle.read({
        buffer,
        offset: 0,
        length: buffer.length,
        position,
      });

      if (!readResult || readResult.bytesRead === 0) {
        break;
      }

      const bytesRead = readResult.bytesRead;
      let writeOffset = 0;
      while (writeOffset < bytesRead) {
        if (shouldCancelRequested(shouldCancel)) {
          throw makeSyncCancelledError();
        }

        await waitForUnpaused(shouldPause, shouldCancel, onPauseTick);

        const writeResult = await targetHandle.write(
          buffer,
          writeOffset,
          bytesRead - writeOffset
        );
        writeOffset += writeResult.bytesWritten;
      }

      position += bytesRead;
      if (typeof onChunk === 'function') {
        onChunk(bytesRead);
      }
    }
  } finally {
    await Promise.all([
      sourceHandle.close().catch(() => undefined),
      targetHandle.close().catch(() => undefined),
    ]);
  }
}
function makeTemporaryBackupPath(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const unique = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `.${base}.lempicka-tmp-${unique}`);
}

async function walkFiles(root, relative = '') {
  const current = path.join(root, relative);
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    throw wrapFilesystemError('Reading directory', current, error);
  }
  const files = [];

  for (const entry of entries) {
    if (isHiddenName(entry.name) || isLikelySystemFile(entry.name)) {
      continue;
    }

    const relPath = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, relPath)));
      continue;
    }

    if (entry.isFile() && hasNormalExtension(entry.name)) {
      const fullPath = path.join(root, relPath);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (error) {
        throw wrapFilesystemError('Reading file metadata', fullPath, error);
      }
      files.push({
        fullPath,
        relativePath: relPath,
        size: stat.size,
      });
    }
  }

  return files;
}

function parseVersionedName(fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  const match = stem.match(/^(.*)_v(\d+)$/i);

  if (!match) {
    return {
      targetFileName: fileName,
      version: 0,
      strippedStem: stem,
      isVersioned: false,
    };
  }

  const baseStem = match[1];
  return {
    targetFileName: `${baseStem}${ext}`,
    version: Number.parseInt(match[2], 10),
    strippedStem: baseStem,
    isVersioned: true,
  };
}

async function buildComparePlan(leftRoot, rightRoot) {
  await ensureDirectoryAvailable(leftRoot, fsConstants.R_OK, 'source directory');
  await ensureDirectoryAvailable(rightRoot, fsConstants.R_OK, 'destination directory');

  const leftFiles = await walkFiles(leftRoot);
  const rightFiles = await walkFiles(rightRoot);

  const rightSizeByRelativePath = new Map();
  for (const rf of rightFiles) {
    rightSizeByRelativePath.set(rf.relativePath, rf.size);
  }

  const bestByTargetRelativePath = new Map();

  for (const lf of leftFiles) {
    const dir = path.dirname(lf.relativePath);
    const fileName = path.basename(lf.relativePath);
    const parsed = parseVersionedName(fileName);
    const targetRelativePath = path.normalize(
      path.join(dir === '.' ? '' : dir, parsed.targetFileName)
    );

    const prev = bestByTargetRelativePath.get(targetRelativePath);
    if (!prev || parsed.version > prev.version) {
      bestByTargetRelativePath.set(targetRelativePath, {
        sourceRelativePath: lf.relativePath,
        sourceFullPath: lf.fullPath,
        sourceSize: lf.size,
        targetRelativePath,
        targetFullPath: path.join(rightRoot, targetRelativePath),
        targetFileName: parsed.targetFileName,
        version: parsed.version,
        isVersioned: parsed.isVersioned,
      });
    }
  }

  const plan = [];
  for (const item of bestByTargetRelativePath.values()) {
    const existingSize = rightSizeByRelativePath.get(item.targetRelativePath);
    const destinationExists = existingSize !== undefined;

    if (destinationExists && existingSize === item.sourceSize) {
      continue;
    }

    plan.push({
      sourcePath: item.sourceFullPath,
      sourceRelativePath: item.sourceRelativePath,
      sourceSize: item.sourceSize,
      targetPath: item.targetFullPath,
      targetRelativePath: item.targetRelativePath,
      version: item.version,
      destinationExists,
      destinationSize: destinationExists ? existingSize : null,
    });
  }

  plan.sort((a, b) => a.targetRelativePath.localeCompare(b.targetRelativePath));

  const directoriesToCreate = [];
  const requiredTargetDirs = new Set();
  for (const item of plan) {
    const targetDir = path.dirname(item.targetRelativePath);
    if (targetDir && targetDir !== '.') {
      requiredTargetDirs.add(targetDir);
    }
  }

  for (const relativeDir of requiredTargetDirs) {
    const fullDir = path.join(rightRoot, relativeDir);
    try {
      const stat = await fs.stat(fullDir);
      if (!stat.isDirectory()) {
        throw new TreeSyncError(
          'DESTINATION_PATH_CONFLICT',
          `Destination path exists but is not a directory: "${relativeDir}".`,
          { relativeDir, fullDir }
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        directoriesToCreate.push(relativeDir);
        continue;
      }
      if (error instanceof TreeSyncError) {
        throw error;
      }
      throw wrapFilesystemError('Validating destination directory', fullDir, error, { relativeDir });
    }
  }

  directoriesToCreate.sort((a, b) => a.localeCompare(b));

  return {
    leftRoot,
    rightRoot,
    plan,
    directoriesToCreate,
    totalCandidates: bestByTargetRelativePath.size,
    pendingCount: plan.length,
  };
}

function normalizePlanItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (!item.sourcePath || !item.targetPath) {
    return null;
  }

  return {
    sourcePath: item.sourcePath,
    sourceRelativePath: item.sourceRelativePath || '',
    sourceSize: Number(item.sourceSize) || 0,
    targetPath: item.targetPath,
    targetRelativePath: item.targetRelativePath || '',
    version: Number.isFinite(Number(item.version)) ? Number(item.version) : 0,
    destinationExists: Boolean(item.destinationExists),
    destinationSize: Number.isFinite(Number(item.destinationSize))
      ? Number(item.destinationSize)
      : null,
  };
}

function createInitialJournalState({ leftRoot, rightRoot, directoriesToCreate, plan, totalBytes }) {
  const now = new Date().toISOString();
  return {
    version: 1,
    leftRoot: typeof leftRoot === 'string' ? leftRoot : '',
    rightRoot: typeof rightRoot === 'string' ? rightRoot : '',
    startedAt: now,
    updatedAt: now,
    directoriesToCreate: Array.isArray(directoriesToCreate) ? directoriesToCreate : [],
    totalBytes: Number(totalBytes) || 0,
    plan: plan.map((item) => normalizePlanItem(item)).filter(Boolean),
    completedTargetPaths: [],
    failed: [],
    activeEntries: {},
    bytesTransferred: 0,
  };
}

async function readSyncJournal(journalPath) {
  if (!journalPath) {
    return null;
  }
  try {
    const raw = await fs.readFile(journalPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeSyncJournal(journalPath, state) {
  if (!journalPath) {
    return;
  }
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await fs.writeFile(journalPath, JSON.stringify(state, null, 2), 'utf8');
}

async function removeSyncJournal(journalPath) {
  if (!journalPath) {
    return;
  }
  try {
    await fs.unlink(journalPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function journalSummaryFromState(state) {
  if (!state || !Array.isArray(state.plan)) {
    return null;
  }
  const completedSet = new Set(Array.isArray(state.completedTargetPaths) ? state.completedTargetPaths : []);
  const pendingCount = state.plan.filter((item) => {
    const normalized = normalizePlanItem(item);
    return normalized && !completedSet.has(normalized.targetPath);
  }).length;

  const totalCount = state.plan.length;
  const completedCount = Math.min(totalCount, completedSet.size);
  const failedCount = Array.isArray(state.failed) ? state.failed.length : 0;
  const activeEntries = state.activeEntries && typeof state.activeEntries === 'object'
    ? state.activeEntries
    : {};

  return {
    leftRoot: typeof state.leftRoot === 'string' ? state.leftRoot : '',
    rightRoot: typeof state.rightRoot === 'string' ? state.rightRoot : '',
    totalCount,
    completedCount,
    pendingCount,
    failedCount,
    activeCount: Object.keys(activeEntries).length,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
  };
}

async function getSyncRecoverySummary(journalPath) {
  const state = await readSyncJournal(journalPath);
  return journalSummaryFromState(state);
}

async function recoverActiveEntriesFromJournal(state) {
  if (!state || !state.activeEntries || typeof state.activeEntries !== 'object') {
    return;
  }

  const entries = Object.values(state.activeEntries);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const targetPath = typeof entry.targetPath === 'string' ? entry.targetPath : '';
    const backupPath = typeof entry.backupPath === 'string' ? entry.backupPath : '';
    if (!targetPath) {
      continue;
    }

    try {
      await fs.unlink(targetPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // Best effort recovery cleanup.
      }
    }

    if (backupPath) {
      try {
        await fs.rename(backupPath, targetPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw new TreeSyncError(
            'RESTORE_FAILED',
            `Failed to restore original destination file "${targetPath}" during recovery (${filesystemHint(error)}).`,
            {
              targetPath,
              backupPath,
              fsCode: error && error.code ? error.code : 'UNKNOWN',
            }
          );
        }
      }
    }
  }

  state.activeEntries = {};
  state.updatedAt = new Date().toISOString();
}

async function resumeSyncFromJournal(journalPath, onProgress, options = {}) {
  const journalState = await readSyncJournal(journalPath);
  if (!journalState) {
    throw new TreeSyncError('NO_RECOVERY_JOURNAL', 'No recovery journal exists to resume from.');
  }

  await recoverActiveEntriesFromJournal(journalState);
  await writeSyncJournal(journalPath, journalState);

  const completedSet = new Set(
    Array.isArray(journalState.completedTargetPaths) ? journalState.completedTargetPaths : []
  );
  const plan = Array.isArray(journalState.plan)
    ? journalState.plan.map((item) => normalizePlanItem(item)).filter(Boolean)
    : [];

  const remainingPlan = plan.filter((item) => !completedSet.has(item.targetPath));
  if (remainingPlan.length === 0) {
    await removeSyncJournal(journalPath);
    return {
      copied: 0,
      total: 0,
      bytesCopied: 0,
      totalBytes: 0,
      failed: [],
      succeededFiles: [],
      durationMs: 0,
      averageThroughputBps: 0,
      leftRoot: typeof journalState.leftRoot === 'string' ? journalState.leftRoot : '',
      rightRoot: typeof journalState.rightRoot === 'string' ? journalState.rightRoot : '',
      resumedFromJournal: true,
    };
  }

  return syncPlan(remainingPlan, onProgress, {
    ...options,
    leftRoot: typeof journalState.leftRoot === 'string' ? journalState.leftRoot : '',
    rightRoot: typeof journalState.rightRoot === 'string' ? journalState.rightRoot : '',
    directoriesToCreate: Array.isArray(journalState.directoriesToCreate)
      ? journalState.directoriesToCreate
      : [],
    journalPath,
    journalState,
    resumeFromJournal: true,
  });
}

async function syncPlan(plan, onProgress, options = {}) {
  if (!Array.isArray(plan)) {
    throw new TreeSyncError('INVALID_PLAN', 'A valid plan is required for sync.');
  }

  const normalizedPlan = plan.map((item) => normalizePlanItem(item)).filter(Boolean);
  const total = normalizedPlan.length;
  const syncStartMs = Date.now();

  let completed = 0;
  let started = 0;
  let bytesTransferred = 0;
  let totalBytes = 0;
  let bytesSinceRateTick = 0;
  let lastRateTickAt = Date.now();
  let lastThroughputBps = 0;
  let lastProgressEmitAt = 0;
  const failed = [];
  const succeededFiles = [];
  const activeTransfers = new Map();

  const leftRoot = typeof options.leftRoot === 'string' ? options.leftRoot : '';
  const rightRoot = typeof options.rightRoot === 'string' ? options.rightRoot : '';
  const syncLogPath = leftRoot ? path.join(leftRoot, 'sync-history.log') : '';
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : () => false;
  const shouldPause = typeof options.shouldPause === 'function' ? options.shouldPause : () => false;
  const continueOnError = Boolean(options.continueOnError);
  const retryCount = Number.isFinite(Number(options.retryCount))
    ? Number(options.retryCount)
    : DEFAULT_RETRY_COUNT;
  const retryBaseDelayMs = Number.isFinite(Number(options.retryBaseDelayMs))
    ? Number(options.retryBaseDelayMs)
    : DEFAULT_RETRY_BASE_DELAY_MS;
  const smallFileThresholdBytes = Number.isFinite(Number(options.smallFileThresholdBytes))
    ? Number(options.smallFileThresholdBytes)
    : DEFAULT_SMALL_FILE_THRESHOLD_BYTES;
  const maxParallelSmallFiles = Math.max(
    1,
    Number.isFinite(Number(options.maxParallelSmallFiles))
      ? Number(options.maxParallelSmallFiles)
      : DEFAULT_MAX_PARALLEL_SMALL_FILES
  );

  const journalPath = typeof options.journalPath === 'string' ? options.journalPath : '';
  const directoriesToCreate = Array.isArray(options.directoriesToCreate)
    ? options.directoriesToCreate.filter((value) => typeof value === 'string' && value.trim())
    : [];

  for (const item of normalizedPlan) {
    const hintedSize = Number(item.sourceSize);
    if (Number.isFinite(hintedSize) && hintedSize >= 0) {
      totalBytes += hintedSize;
      continue;
    }
    try {
      const stat = await fs.stat(item.sourcePath);
      item.sourceSize = stat.size;
      totalBytes += stat.size;
    } catch (error) {
      throw new TreeSyncError(
        'SOURCE_UNAVAILABLE',
        `Sync setup failed: source file is unavailable "${item.sourcePath}".`,
        {
          completed,
          total,
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          fsCode: error && error.code ? error.code : 'UNKNOWN',
        }
      );
    }
  }

  let journalState = options.journalState && typeof options.journalState === 'object'
    ? options.journalState
    : createInitialJournalState({
        leftRoot,
        rightRoot,
        directoriesToCreate,
        plan: normalizedPlan,
        totalBytes,
      });

  if (!Array.isArray(journalState.completedTargetPaths)) {
    journalState.completedTargetPaths = [];
  }
  if (!Array.isArray(journalState.failed)) {
    journalState.failed = [];
  }
  if (!journalState.activeEntries || typeof journalState.activeEntries !== 'object') {
    journalState.activeEntries = {};
  }

  let journalWriteChain = Promise.resolve();
  const queueJournalWrite = async () => {
    if (!journalPath) {
      return;
    }
    journalState.updatedAt = new Date().toISOString();
    journalState.bytesTransferred = bytesTransferred;
    journalWriteChain = journalWriteChain.then(() => writeSyncJournal(journalPath, journalState));
    await journalWriteChain;
  };

  await queueJournalWrite();

  let syncLogHandle = null;
  let syncLogWriteChain = Promise.resolve();

  const queueSyncLogWrite = async (line) => {
    if (!syncLogHandle) {
      return;
    }
    syncLogWriteChain = syncLogWriteChain.then(() => syncLogHandle.write(line));
    await syncLogWriteChain;
  };

  if (syncLogPath) {
    try {
      syncLogHandle = await fs.open(syncLogPath, 'a');
    } catch (error) {
      throw new TreeSyncError(
        'SYNC_LOG_ERROR',
        `Cannot open sync log file "${syncLogPath}" (${filesystemHint(error)}).`,
        {
          completed,
          total,
          logPath: syncLogPath,
          fsCode: error && error.code ? error.code : 'UNKNOWN',
        }
      );
    }
  }

  const completedSet = new Set(journalState.completedTargetPaths);

  const emitProgress = (phase, item, extra = {}) => {
    if (typeof onProgress !== 'function') {
      return;
    }

    const now = Date.now();
    const force = Boolean(extra.force) || phase !== 'copying';
    if (!force && (now - lastProgressEmitAt) < 250) {
      return;
    }

    const elapsedSinceRateTick = Math.max(1, now - lastRateTickAt);
    if (elapsedSinceRateTick >= 1000 || force) {
      lastThroughputBps = Math.round((bytesSinceRateTick * 1000) / elapsedSinceRateTick);
      bytesSinceRateTick = 0;
      lastRateTickAt = now;
    }

    let currentFileBytes = 0;
    let currentFileTotalBytes = 0;
    const itemKey = item ? item.targetPath : '';
    if (itemKey && activeTransfers.has(itemKey)) {
      const transferState = activeTransfers.get(itemKey);
      currentFileBytes = transferState.bytesTransferred;
      currentFileTotalBytes = transferState.totalBytes;
    }

    try {
      onProgress({
        phase,
        currentIndex: Math.min(started, total),
        completed,
        failed: failed.length,
        total,
        totalBytes,
        bytesTransferred,
        throughputBps: lastThroughputBps,
        targetRelativePath: item ? item.targetRelativePath : '',
        currentFileBytes,
        currentFileTotalBytes,
        activeCount: activeTransfers.size,
        isPaused: shouldPauseRequested(shouldPause),
        retryAttempt: Number(extra.retryAttempt) || 0,
        message: typeof extra.message === 'string' ? extra.message : '',
      });
    } catch (error) {
      // UI callback failures should not interrupt file operations.
    }

    lastProgressEmitAt = now;
  };

  const markItemFailed = async (item, error) => {
    const failure = {
      sourceRelativePath: item.sourceRelativePath,
      targetRelativePath: item.targetRelativePath,
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      code: error instanceof TreeSyncError ? error.code : 'SYNC_COPY_FAILED',
      message: error && error.message ? error.message : 'Unknown sync error.',
    };
    failed.push(failure);

    journalState.failed = Array.isArray(journalState.failed) ? journalState.failed : [];
    journalState.failed.push({
      targetPath: item.targetPath,
      targetRelativePath: item.targetRelativePath,
      code: failure.code,
      message: failure.message,
      at: new Date().toISOString(),
    });
    await queueJournalWrite();

    emitProgress('failed', item, { force: true, message: failure.message });
  };

  const processItemAttempt = async (item, attempt) => {
    if (shouldCancelRequested(shouldCancel)) {
      throw makeSyncCancelledError({ completed, total });
    }

    await waitForUnpaused(shouldPause, shouldCancel, async () => {
      emitProgress('paused', item, { force: true, message: 'Paused' });
    });

    if (attempt === 0) {
      started += 1;
    }

    const transferState = {
      bytesTransferred: 0,
      totalBytes: Number(item.sourceSize) || 0,
    };
    activeTransfers.set(item.targetPath, transferState);
    emitProgress('copying', item, { force: true });

    let backupPath = '';

    journalState.activeEntries[item.targetPath] = {
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      sourceRelativePath: item.sourceRelativePath,
      targetRelativePath: item.targetRelativePath,
      backupPath: '',
      startedAt: new Date().toISOString(),
      attempt: attempt + 1,
    };
    await queueJournalWrite();

    try {
      try {
        await fs.access(item.sourcePath, fsConstants.R_OK);
      } catch (error) {
        throw new TreeSyncError(
          'SOURCE_UNAVAILABLE',
          `Source file is unavailable "${item.sourcePath}" (${filesystemHint(error)}).`,
          {
            sourcePath: item.sourcePath,
            targetPath: item.targetPath,
            fsCode: error && error.code ? error.code : 'UNKNOWN',
          }
        );
      }

      let destinationStat = null;
      try {
        destinationStat = await fs.stat(item.targetPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      }

      if (destinationStat) {
        if (!destinationStat.isFile()) {
          throw new TreeSyncError(
            'DESTINATION_PATH_CONFLICT',
            `Destination exists but is not a regular file "${item.targetPath}".`,
            {
              sourcePath: item.sourcePath,
              targetPath: item.targetPath,
            }
          );
        }

        backupPath = makeTemporaryBackupPath(item.targetPath);
        await fs.rename(item.targetPath, backupPath);
        journalState.activeEntries[item.targetPath].backupPath = backupPath;
        await queueJournalWrite();
      }

      await copyFileWithProgress(
        item.sourcePath,
        item.targetPath,
        (chunkBytes) => {
          bytesTransferred += chunkBytes;
          bytesSinceRateTick += chunkBytes;
          transferState.bytesTransferred += chunkBytes;
          emitProgress('copying', item);
        },
        {
          writeFlags: 'wx',
          shouldCancel,
          shouldPause,
          onPauseTick: () => {
            emitProgress('paused', item, { force: true, message: 'Paused' });
          },
        }
      );

      await tryPreserveCreationDate(item.sourcePath, item.targetPath);

      if (backupPath) {
        try {
          await fs.unlink(backupPath);
          backupPath = '';
        } catch (error) {
          throw new TreeSyncError(
            'BACKUP_CLEANUP_FAILED',
            `Copied file but failed to remove temporary backup "${backupPath}" (${filesystemHint(error)}).`,
            {
              sourcePath: item.sourcePath,
              targetPath: item.targetPath,
              backupPath,
              fsCode: error && error.code ? error.code : 'UNKNOWN',
            }
          );
        }
      }

      completed += 1;
      succeededFiles.push({
        sourceRelativePath: item.sourceRelativePath,
        targetRelativePath: item.targetRelativePath,
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
      });
      completedSet.add(item.targetPath);

      journalState.completedTargetPaths = Array.from(completedSet);
      delete journalState.activeEntries[item.targetPath];
      await queueJournalWrite();

      const timestamp = localTimestampString();
      const line = `${timestamp}\t${item.sourcePath}\t${item.targetPath}\n`;
      await queueSyncLogWrite(line);

      emitProgress('copied', item, { force: true });
    } catch (error) {
      try {
        await fs.unlink(item.targetPath);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') {
          // Best effort cleanup.
        }
      }

      if (backupPath) {
        try {
          await fs.rename(backupPath, item.targetPath);
          backupPath = '';
        } catch (restoreError) {
          throw new TreeSyncError(
            'RESTORE_FAILED',
            `Failed to restore original destination file "${item.targetPath}" (${filesystemHint(restoreError)}).`,
            {
              sourcePath: item.sourcePath,
              targetPath: item.targetPath,
              fsCode: restoreError && restoreError.code ? restoreError.code : 'UNKNOWN',
            }
          );
        }
      }

      delete journalState.activeEntries[item.targetPath];
      await queueJournalWrite();

      if (isSyncCancelledError(error) || shouldCancelRequested(shouldCancel)) {
        throw makeSyncCancelledError({
          completed,
          total,
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
        });
      }

      throw error;
    } finally {
      activeTransfers.delete(item.targetPath);
    }
  };

  const processItemWithRetryAndFailureHandling = async (item) => {
    try {
      await withRetry(
        async (attempt) => {
          await processItemAttempt(item, attempt);
        },
        {
          retries: retryCount,
          baseDelayMs: retryBaseDelayMs,
          shouldCancel,
          shouldPause,
          onRetry: async ({ attempt, retryDelayMs, error }) => {
            emitProgress('retrying', item, {
              force: true,
              retryAttempt: attempt,
              message: `Retrying in ${Math.round(retryDelayMs)}ms: ${filesystemHint(error)}`,
            });
          },
        }
      );
    } catch (error) {
      if (isSyncCancelledError(error)) {
        throw error;
      }

      await markItemFailed(item, error);
      if (!continueOnError) {
        throw error;
      }
    }
  };

  const buildResult = () => {
    const durationMs = Math.max(0, Date.now() - syncStartMs);
    const averageThroughputBps = durationMs > 0
      ? Math.round((bytesTransferred * 1000) / durationMs)
      : 0;

    return {
      copied: completed,
      total,
      bytesCopied: bytesTransferred,
      totalBytes,
      failed,
      succeededFiles,
      durationMs,
      averageThroughputBps,
      leftRoot,
      rightRoot,
      resumedFromJournal: Boolean(options.resumeFromJournal),
    };
  };

  let success = false;
  let abortError = null;

  try {
    for (const relativeDir of directoriesToCreate) {
      if (shouldCancelRequested(shouldCancel)) {
        throw makeSyncCancelledError({ completed, total });
      }

      const matchingPlanItem = normalizedPlan.find(
        (item) => path.dirname(item.targetRelativePath || '') === relativeDir
      );
      const fullDir = matchingPlanItem
        ? path.dirname(matchingPlanItem.targetPath)
        : path.join(rightRoot || '', relativeDir);

      await withRetry(
        async () => {
          await fs.mkdir(fullDir, { recursive: true });
        },
        {
          retries: retryCount,
          baseDelayMs: retryBaseDelayMs,
          shouldCancel,
          shouldPause,
        }
      );
    }

    const pendingPlan = normalizedPlan.filter((item) => !completedSet.has(item.targetPath));
    const smallFiles = pendingPlan.filter((item) => Number(item.sourceSize) <= smallFileThresholdBytes);
    const largeFiles = pendingPlan.filter((item) => Number(item.sourceSize) > smallFileThresholdBytes);

    const parallelSmallEnabled = continueOnError && maxParallelSmallFiles > 1;
    const workerCount = parallelSmallEnabled
      ? Math.max(1, Math.min(maxParallelSmallFiles, smallFiles.length || 1))
      : 1;

    if (smallFiles.length > 0) {
      if (workerCount === 1) {
        for (const item of smallFiles) {
          if (shouldCancelRequested(shouldCancel)) {
            throw makeSyncCancelledError({ completed, total });
          }
          await processItemWithRetryAndFailureHandling(item);
        }
      } else {
        const queue = [...smallFiles];
        const workers = [];
        for (let i = 0; i < workerCount; i += 1) {
          workers.push((async () => {
            while (queue.length > 0) {
              if (shouldCancelRequested(shouldCancel)) {
                throw makeSyncCancelledError({ completed, total });
              }
              const item = queue.shift();
              if (!item) {
                return;
              }
              await processItemWithRetryAndFailureHandling(item);
            }
          })());
        }
        await Promise.all(workers);
      }
    }

    for (const item of largeFiles) {
      if (shouldCancelRequested(shouldCancel)) {
        throw makeSyncCancelledError({ completed, total });
      }
      await processItemWithRetryAndFailureHandling(item);
    }

    success = true;
  } catch (error) {
    abortError = error;
  } finally {
    try {
      await syncLogWriteChain;
    } catch (error) {
      // If logging chain failed, sync already surfaced error where it occurred.
    }

    if (syncLogHandle) {
      try {
        await syncLogHandle.close();
      } catch (error) {
        // No-op.
      }
    }

    try {
      await journalWriteChain;
    } catch (error) {
      // Journal write failures are raised at mutation time.
    }

    if (success) {
      await removeSyncJournal(journalPath);
    }
  }

  if (abortError) {
    const partialResult = buildResult();

    if (abortError instanceof TreeSyncError) {
      abortError.details = {
        ...(abortError.details && typeof abortError.details === 'object' ? abortError.details : {}),
        partialResult,
      };
      throw abortError;
    }

    throw new TreeSyncError(
      'SYNC_ABORTED',
      abortError && abortError.message ? abortError.message : 'Sync aborted unexpectedly.',
      { partialResult }
    );
  }

  emitProgress('complete', null, { force: true });
  return buildResult();
}

module.exports = {
  walkFiles,
  parseVersionedName,
  buildComparePlan,
  syncPlan,
  getSyncRecoverySummary,
  resumeSyncFromJournal,
  TreeSyncError,
};
