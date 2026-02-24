const fs = require('fs/promises');
const { constants: fsConstants, createReadStream, createWriteStream } = require('fs');
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

async function copyFileWithProgress(sourcePath, targetPath, onChunk, writeFlags = 'w') {
  await new Promise((resolve, reject) => {
    const input = createReadStream(sourcePath);
    const output = createWriteStream(targetPath, { flags: writeFlags });
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      input.destroy();
      output.destroy();
      reject(error);
    };

    input.on('data', (chunk) => {
      if (typeof onChunk === 'function') {
        onChunk(chunk.length);
      }
    });
    input.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });

    input.pipe(output);
  });
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

async function syncPlan(plan, onProgress, options = {}) {
  if (!Array.isArray(plan)) {
    throw new TreeSyncError('INVALID_PLAN', 'A valid plan is required for sync.');
  }

  const total = plan.length;
  let completed = 0;
  let bytesTransferred = 0;
  let totalBytes = 0;
  let bytesSinceRateTick = 0;
  let lastRateTickAt = Date.now();
  const leftRoot = typeof options.leftRoot === 'string' ? options.leftRoot : '';
  const syncLogPath = leftRoot ? path.join(leftRoot, 'sync-history.log') : '';
  let syncLogHandle = null;
  const directoriesToCreate = Array.isArray(options.directoriesToCreate)
    ? options.directoriesToCreate.filter((value) => typeof value === 'string' && value.trim())
    : [];

  for (const item of plan) {
    const hintedSize = Number(item && item.sourceSize);
    if (Number.isFinite(hintedSize) && hintedSize >= 0) {
      totalBytes += hintedSize;
      continue;
    }
    try {
      const stat = await fs.stat(item.sourcePath);
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

  try {
    for (const relativeDir of directoriesToCreate) {
      const matchingPlanItem = plan.find(
        (item) => path.dirname(item.targetRelativePath || '') === relativeDir
      );
      const fullDir = matchingPlanItem
        ? path.dirname(matchingPlanItem.targetPath)
        : path.join(options.rightRoot || '', relativeDir);

      try {
        await fs.mkdir(fullDir, { recursive: true });
      } catch (error) {
        throw new TreeSyncError(
          'DESTINATION_UNAVAILABLE',
          `Cannot create destination folder "${relativeDir}" (${filesystemHint(error)}).`,
          {
            completed,
            total,
            relativeDir,
            targetPath: fullDir,
            fsCode: error && error.code ? error.code : 'UNKNOWN',
          }
        );
      }
    }

    for (const item of plan) {
      if (!item || !item.sourcePath || !item.targetPath) {
        throw new TreeSyncError(
          'INVALID_PLAN_ITEM',
          'Sync plan contains an invalid item.',
          { completed, total }
        );
      }

      try {
        await fs.access(item.sourcePath, fsConstants.R_OK);
      } catch (error) {
        throw new TreeSyncError(
          'SOURCE_UNAVAILABLE',
          `Sync stopped at ${completed}/${total}: source file is unavailable "${item.sourcePath}".`,
          {
            completed,
            total,
            sourcePath: item.sourcePath,
            targetPath: item.targetPath,
            fsCode: error && error.code ? error.code : 'UNKNOWN',
          }
        );
      }

      if (typeof onProgress === 'function') {
        try {
          onProgress({
            phase: 'copying',
            currentIndex: completed + 1,
            completed,
            total,
            totalBytes,
            bytesTransferred,
            throughputBps: 0,
            targetRelativePath: item.targetRelativePath,
          });
        } catch (error) {
          // UI callback failures should not interrupt file operations.
        }
      }

      try {
        try {
          await fs.unlink(item.targetPath);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            throw new TreeSyncError(
              'DESTINATION_UNAVAILABLE',
              `Sync stopped at ${completed}/${total}: cannot remove destination "${item.targetPath}" (${filesystemHint(error)}).`,
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

        await copyFileWithProgress(item.sourcePath, item.targetPath, (chunkBytes) => {
          bytesTransferred += chunkBytes;
          bytesSinceRateTick += chunkBytes;

          const now = Date.now();
          const elapsedMs = now - lastRateTickAt;
          if (elapsedMs < 1000) {
            return;
          }

          const throughputBps = elapsedMs > 0
            ? Math.round((bytesSinceRateTick * 1000) / elapsedMs)
            : 0;
          bytesSinceRateTick = 0;
          lastRateTickAt = now;

          if (typeof onProgress === 'function') {
            try {
              onProgress({
                phase: 'copying',
                currentIndex: completed + 1,
                completed,
                total,
                totalBytes,
                bytesTransferred,
                throughputBps,
                targetRelativePath: item.targetRelativePath,
              });
            } catch (error) {
              // UI callback failures should not interrupt file operations.
            }
          }
        }, 'wx');
        await tryPreserveCreationDate(item.sourcePath, item.targetPath);
      } catch (error) {
        if (error instanceof TreeSyncError) {
          throw error;
        }
        const base = `Sync stopped at ${completed}/${total} while writing "${item.targetPath}".`;
        let message = `${base} ${filesystemHint(error)}`;
        if (error && error.code === 'ENOSPC') {
          message = `${base} No space left on destination device.`;
        }
        throw new TreeSyncError('SYNC_COPY_FAILED', message, {
          completed,
          total,
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          fsCode: error && error.code ? error.code : 'UNKNOWN',
        });
      }

      completed += 1;

      if (syncLogHandle) {
        const timestamp = localTimestampString();
        const line = `${timestamp}\t${item.sourcePath}\t${item.targetPath}\n`;
        try {
          await syncLogHandle.write(line);
        } catch (error) {
          throw new TreeSyncError(
            'SYNC_LOG_ERROR',
            `Cannot write sync log file "${syncLogPath}" (${filesystemHint(error)}).`,
            {
              completed,
              total,
              sourcePath: item.sourcePath,
              targetPath: item.targetPath,
              logPath: syncLogPath,
              fsCode: error && error.code ? error.code : 'UNKNOWN',
            }
          );
        }
      }

      if (typeof onProgress === 'function') {
        try {
          const now = Date.now();
          const elapsedMs = now - lastRateTickAt;
          const throughputBps = elapsedMs > 0
            ? Math.round((bytesSinceRateTick * 1000) / elapsedMs)
            : 0;
          bytesSinceRateTick = 0;
          lastRateTickAt = now;

          onProgress({
            phase: 'copied',
            currentIndex: completed,
            completed,
            total,
            totalBytes,
            bytesTransferred,
            throughputBps,
            targetRelativePath: item.targetRelativePath,
          });
        } catch (error) {
          // UI callback failures should not interrupt file operations.
        }
      }
    }
  } finally {
    if (syncLogHandle) {
      try {
        await syncLogHandle.close();
      } catch (error) {
        // No-op: syncing result has already been determined.
      }
    }
  }

  return {
    copied: completed,
    total,
    bytesCopied: bytesTransferred,
    totalBytes,
  };
}

module.exports = {
  walkFiles,
  parseVersionedName,
  buildComparePlan,
  syncPlan,
  TreeSyncError,
};
