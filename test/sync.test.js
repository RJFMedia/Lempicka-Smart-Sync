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

test('syncPlan copies files and emits progress', async () => {
  await withTempDirs(async ({ left, right }) => {
    await writeFile(left, 'a_v2.txt', 'hello');
    const compare = await buildComparePlan(left, right);
    const progressEvents = [];

    const syncResult = await syncPlan(compare.plan, (progress) => {
      progressEvents.push(progress);
    });

    assert.equal(syncResult.copied, 1);
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0].completed, 1);
    assert.equal(progressEvents[0].total, 1);

    const copied = await fs.readFile(path.join(right, 'a.txt'), 'utf8');
    assert.equal(copied, 'hello');
  });
});
