const fs = require('fs/promises');
const path = require('path');

async function walkFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relPath = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, relPath)));
      continue;
    }

    if (entry.isFile()) {
      const fullPath = path.join(root, relPath);
      const stat = await fs.stat(fullPath);
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

  return {
    leftRoot,
    rightRoot,
    plan,
    totalCandidates: bestByTargetRelativePath.size,
    pendingCount: plan.length,
  };
}

async function syncPlan(plan, onProgress) {
  if (!Array.isArray(plan)) {
    throw new Error('A valid plan is required for sync.');
  }

  const total = plan.length;
  let completed = 0;

  for (const item of plan) {
    await fs.mkdir(path.dirname(item.targetPath), { recursive: true });
    await fs.copyFile(item.sourcePath, item.targetPath);
    completed += 1;

    if (typeof onProgress === 'function') {
      onProgress({
        completed,
        total,
        targetRelativePath: item.targetRelativePath,
      });
    }
  }

  return {
    copied: completed,
    total,
  };
}

module.exports = {
  walkFiles,
  parseVersionedName,
  buildComparePlan,
  syncPlan,
};
