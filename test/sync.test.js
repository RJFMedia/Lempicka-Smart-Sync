const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const {
  parseVersionedName,
  buildComparePlan,
  syncPlan,
  getSyncRecoverySummary,
  resumeSyncFromJournal,
} = require('../src/core/sync');

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
    assert.equal(syncResult.failed.length, 0);
    assert.ok(progressEvents.some((event) => event.phase === 'copying'));
    assert.ok(progressEvents.some((event) => event.phase === 'copied'));

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
      /source file is unavailable/i
    );

    const firstContents = await fs.readFile(path.join(right, 'first.txt'), 'utf8');
    assert.equal(firstContents, 'first');
  });
});

test('syncPlan can continue past per-file errors and report failures', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'first_v1.txt', 'first');
    await writeFile(left, 'second_v1.txt', 'second');

    const compare = await buildComparePlan(left, right);
    const secondItem = compare.plan.find((item) => item.targetRelativePath === 'second.txt');
    await fs.rm(secondItem.sourcePath);

    const result = await syncPlan(compare.plan, undefined, {
      continueOnError: true,
    });

    assert.equal(result.copied, 1);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].targetRelativePath, /second\.txt$/);

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
    assert.ok(lines.every((line) => /\t/.test(line)));
    assert.equal(lines.filter((line) => line.endsWith(path.join(right, 'a.txt'))).length, 2);
    assert.equal(lines.filter((line) => line.endsWith(path.join(right, 'b.txt'))).length, 1);
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

test('syncPlan reports bytesCopied for successful files only when cancelled mid-file', async () => {
  await withTempDirs(async ({ left, right }) => {
    const firstContent = 'first';
    const largeSecond = Buffer.alloc(96 * 1024 * 1024, 'z');

    await writeFile(left, 'first_v1.txt', firstContent);
    await writeFile(left, 'second_v1.txt', largeSecond);

    const compare = await buildComparePlan(left, right);
    let cancelRequested = false;

    await assert.rejects(
      () => syncPlan(compare.plan, (progress) => {
        if (
          progress
          && progress.phase === 'copying'
          && progress.targetRelativePath === 'second.txt'
        ) {
          cancelRequested = true;
        }
      }, {
        shouldCancel: () => cancelRequested,
      }),
      (error) => {
        assert.equal(error && error.code, 'SYNC_CANCELLED');
        const partial = error && error.details ? error.details.partialResult : null;
        assert.ok(partial);
        assert.equal(partial.copied, 1);
        assert.equal(partial.bytesCopied, Buffer.byteLength(firstContent));
        return true;
      }
    );
  });
});

test('sync recovery journal can resume remaining files after cancellation', async () => {
  await withTempDirs(async ({ left, right, root }) => {
    await writeFile(left, 'one_v1.txt', '1111');
    await writeFile(left, 'two_v1.txt', '2222');

    const compare = await buildComparePlan(left, right);
    const journalPath = path.join(root, 'sync-recovery.json');

    let cancelRequested = false;
    await assert.rejects(
      () => syncPlan(compare.plan, (progress) => {
        if (progress.phase === 'copied' && progress.completed >= 1) {
          cancelRequested = true;
        }
      }, {
        leftRoot: left,
        rightRoot: right,
        journalPath,
        continueOnError: true,
        shouldCancel: () => cancelRequested,
        maxParallelSmallFiles: 1,
      }),
      /cancelled/i
    );

    const summary = await getSyncRecoverySummary(journalPath);
    assert.ok(summary);
    assert.equal(summary.pendingCount, 1);

    const resumed = await resumeSyncFromJournal(journalPath, undefined, {
      continueOnError: true,
    });
    assert.equal(resumed.copied, 1);

    const finalSummary = await getSyncRecoverySummary(journalPath);
    assert.equal(finalSummary, null);

    const one = await fs.readFile(path.join(right, 'one.txt'), 'utf8');
    const two = await fs.readFile(path.join(right, 'two.txt'), 'utf8');
    assert.equal(one, '1111');
    assert.equal(two, '2222');
  });
});

test('buildComparePlan rejects root and overlapping directories', async () => {
  await withTempDirs(async ({ left, right }) => {
    const filesystemRoot = path.parse(process.cwd()).root;

    await assert.rejects(
      () => buildComparePlan(filesystemRoot, right),
      /unsafe source directory/i
    );

    await assert.rejects(
      () => buildComparePlan(left, left),
      /non-overlapping/i
    );

    const nestedDestination = path.join(left, 'nested-destination');
    await fs.mkdir(nestedDestination, { recursive: true });

    await assert.rejects(
      () => buildComparePlan(left, nestedDestination),
      /non-overlapping/i
    );
  });
});

test('buildComparePlan rejects symlink roots', { skip: process.platform === 'win32' }, async () => {
  await withTempDirs(async ({ left, right, root }) => {
    const linkedLeft = path.join(root, 'left-link');
    await fs.symlink(left, linkedLeft);

    await assert.rejects(
      () => buildComparePlan(linkedLeft, right),
      /cannot be a symlink/i
    );
  });
});

test('buildComparePlan ignores symlink files and directories', { skip: process.platform === 'win32' }, async () => {
  await withTempDirs(async ({ left, right, root }) => {
    await writeFile(left, 'real/keep_v2.txt', 'keep');

    const externalFile = path.join(root, 'outside-file_v9.txt');
    await fs.writeFile(externalFile, 'linked');
    await fs.symlink(externalFile, path.join(left, 'linked-file_v9.txt'));

    const externalDir = path.join(root, 'outside-dir');
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, 'inside_v4.txt'), 'inside');
    await fs.symlink(externalDir, path.join(left, 'linked-dir'));

    const result = await buildComparePlan(left, right);
    assert.equal(result.plan.length, 1);
    assert.equal(result.plan[0].targetRelativePath, path.normalize('real/keep.txt'));
  });
});

test('syncPlan rejects plan paths that escape selected roots', async () => {
  await withTempDirs(async ({ left, right, root }) => {
    await writeFile(left, 'clip_v1.txt', 'abc');
    const compare = await buildComparePlan(left, right);

    const mutatedPlan = compare.plan.map((item) => ({ ...item }));
    mutatedPlan[0].targetPath = path.join(root, 'outside.txt');

    await assert.rejects(
      () => syncPlan(mutatedPlan, undefined, {
        leftRoot: left,
        rightRoot: right,
      }),
      /escapes selected destination directory/i
    );
  });
});

test('syncPlan cleans temporary backup and write files after success', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'clip_v2.txt', 'new-content-longer');
    await writeFile(right, 'clip.txt', 'old');

    const compare = await buildComparePlan(left, right);
    const result = await syncPlan(compare.plan, undefined, {
      leftRoot: left,
      rightRoot: right,
    });

    assert.equal(result.copied, 1);

    const rightEntries = await fs.readdir(right);
    assert.equal(
      rightEntries.some((name) => /\.lempicka-(tmp|write)-/.test(name)),
      false
    );
  });
});
