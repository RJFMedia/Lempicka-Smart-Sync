const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const { parseVersionedName, buildComparePlan, syncPlan } = require('../src/core/sync');

async function withTempDirs(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-sync-test-'));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  await fs.mkdir(left, { recursive: true });
  await fs.mkdir(right, { recursive: true });

  try {
    await run({ left, right, root });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeFile(base, relativePath, content) {
  const fullPath = path.join(base, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

test('parseVersionedName handles versioned and non-versioned names', () => {
  assert.deepEqual(parseVersionedName('notes.txt'), {
    targetFileName: 'notes.txt',
    version: 0,
    strippedStem: 'notes',
    isVersioned: false,
  });

  assert.deepEqual(parseVersionedName('notes_v12.txt'), {
    targetFileName: 'notes.txt',
    version: 12,
    strippedStem: 'notes',
    isVersioned: true,
  });
});

test('buildComparePlan picks latest version and skips same-size targets', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'folder/doc_v1.txt', 'one');
    await writeFile(left, 'folder/doc_v3.txt', 'three');
    await writeFile(right, 'folder/doc.txt', 'old');

    const result = await buildComparePlan(left, right);
    assert.equal(result.pendingCount, 1);
    assert.equal(result.plan[0].sourceRelativePath, path.normalize('folder/doc_v3.txt'));
    assert.equal(result.plan[0].targetRelativePath, path.normalize('folder/doc.txt'));
    assert.equal(result.plan[0].version, 3);
  });
});

test('buildComparePlan lists destination folders that need to be created', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'alpha/beta/file_v1.txt', 'hello');

    const result = await buildComparePlan(left, right);
    assert.deepEqual(result.directoriesToCreate, [path.normalize('alpha/beta')]);
  });
});

test('buildComparePlan ignores hidden/system files and files without extensions', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, '.hidden/file_v1.txt', 'nope');
    await writeFile(left, '.DS_Store', 'nope');
    await writeFile(left, 'Thumbs.db', 'nope');
    await writeFile(left, 'desktop.ini', 'nope');
    await writeFile(left, 'notes_v3', 'no extension');
    await writeFile(left, 'visible/readme_v2.txt', 'ok');

    const result = await buildComparePlan(left, right);
    assert.equal(result.plan.length, 1);
    assert.equal(result.plan[0].targetRelativePath, path.normalize('visible/readme.txt'));
  });
});

test('syncPlan copies files and emits progress', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'a_v2.txt', 'hello');
    const compare = await buildComparePlan(left, right);
    const progressEvents = [];

    const syncResult = await syncPlan(compare.plan, (progress) => {
      progressEvents.push(progress);
    });

    assert.equal(syncResult.copied, 1);
    assert.equal(progressEvents.length, 2);
    assert.equal(progressEvents[0].phase, 'copying');
    assert.equal(progressEvents[0].currentIndex, 1);
    assert.equal(progressEvents[0].completed, 0);
    assert.equal(progressEvents[0].total, 1);
    assert.equal(progressEvents[0].totalBytes, 5);
    assert.equal(progressEvents[0].bytesTransferred, 0);
    assert.equal(progressEvents[1].phase, 'copied');
    assert.equal(progressEvents[1].currentIndex, 1);
    assert.equal(progressEvents[1].completed, 1);
    assert.equal(progressEvents[1].total, 1);
    assert.equal(progressEvents[1].totalBytes, 5);
    assert.equal(progressEvents[1].bytesTransferred, 5);

    const copied = await fs.readFile(path.join(right, 'a.txt'), 'utf8');
    assert.equal(copied, 'hello');
  });
});

test('buildComparePlan fails with a clear message when source directory is missing', async () => {
  await withTempDirs(async ({ right, root }) => {
    const missingLeft = path.join(root, 'missing-left');

    await assert.rejects(
      () => buildComparePlan(missingLeft, right),
      /Accessing source directory failed/
    );
  });
});

test('syncPlan reports partial progress when a source file disappears mid-sync', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'first_v1.txt', 'first');
    await writeFile(left, 'second_v1.txt', 'second');

    const compare = await buildComparePlan(left, right);
    const secondItem = compare.plan.find((item) => item.targetRelativePath === 'second.txt');
    await fs.rm(secondItem.sourcePath);

    const syncPromise = syncPlan(compare.plan);
    await assert.rejects(
      syncPromise,
      /Sync stopped at 1\/2: source file is unavailable/
    );

    const firstContents = await fs.readFile(path.join(right, 'first.txt'), 'utf8');
    assert.equal(firstContents, 'first');
  });
});

test('syncPlan creates planned destination folders before copying', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'deep/path/file_v1.txt', 'hello');
    const compare = await buildComparePlan(left, right);
    assert.deepEqual(compare.directoriesToCreate, [path.normalize('deep/path')]);

    const syncResult = await syncPlan(compare.plan, undefined, {
      rightRoot: right,
      directoriesToCreate: compare.directoriesToCreate,
    });
    assert.equal(syncResult.copied, 1);

    const dirStat = await fs.stat(path.join(right, 'deep/path'));
    assert.equal(dirStat.isDirectory(), true);
    const copied = await fs.readFile(path.join(right, 'deep/path/file.txt'), 'utf8');
    assert.equal(copied, 'hello');
  });
});

test('syncPlan creates and appends sync-history.log in source root', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'a_v1.txt', 'A1');
    await writeFile(left, 'b_v1.txt', 'B1');

    const firstCompare = await buildComparePlan(left, right);
    await syncPlan(firstCompare.plan, undefined, {
      leftRoot: left,
      rightRoot: right,
      directoriesToCreate: firstCompare.directoriesToCreate,
    });

    await writeFile(left, 'a_v2.txt', 'A222');
    const secondCompare = await buildComparePlan(left, right);
    await syncPlan(secondCompare.plan, undefined, {
      leftRoot: left,
      rightRoot: right,
      directoriesToCreate: secondCompare.directoriesToCreate,
    });

    const logPath = path.join(left, 'sync-history.log');
    const logContents = await fs.readFile(logPath, 'utf8');
    const lines = logContents.trim().split('\n');

    assert.equal(lines.length, 3);
    assert.match(lines[0], /\t/);
    assert.match(lines[0], new RegExp(`\\t${path.join(right, 'a.txt')}$`));
    assert.match(lines[1], new RegExp(`\\t${path.join(right, 'b.txt')}$`));
    assert.match(lines[2], new RegExp(`\\t${path.join(right, 'a.txt')}$`));
  });
});

test('buildComparePlan ignores sync-history.log', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'sync-history.log', 'old log');
    await writeFile(left, 'real_v1.txt', 'real');

    const result = await buildComparePlan(left, right);
    assert.equal(result.plan.length, 1);
    assert.equal(result.plan[0].targetRelativePath, 'real.txt');
  });
});

test('syncPlan restores original destination file when cancelled during replacement', async () => {
  await withTempDirs(async ({ left, right }) => {
    const largeContent = Buffer.alloc(8 * 1024 * 1024, 'a');
    await writeFile(left, 'clip_v2.txt', largeContent);
    await writeFile(right, 'clip.txt', 'old-destination-content');

    const compare = await buildComparePlan(left, right);
    let cancelRequested = false;

    await assert.rejects(
      () => syncPlan(compare.plan, () => {
        cancelRequested = true;
      }, {
        shouldCancel: () => cancelRequested,
      }),
      /cancelled/i
    );

    const restored = await fs.readFile(path.join(right, 'clip.txt'), 'utf8');
    assert.equal(restored, 'old-destination-content');
  });
});
