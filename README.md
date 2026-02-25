# Lempicka Smart Sync

Lempicka Smart Sync compares a source directory (versioned files) with a destination directory (unversioned files), then syncs only files that need updating.

## How It Works

- Source files can be versioned like `name_v001.ext`.
- Destination files are unversioned like `name.ext`.
- If multiple source versions exist, the highest version is selected.
- A file is synced when the destination file is missing or has a different size.
- Missing destination subfolders are created during sync (with confirmation before creation).

## Using the App

1. Select a **Source Directory (versioned)**.
2. Select a **Destination Directory (unversioned)**.
3. Click **Compare** to preview files that will be copied.
4. Review the compare table and total bytes to transfer.
5. Click **Sync** to start transfer.
6. Use **Cancel** (or Pause/Resume if shown) to control an in-progress sync.

## Safety Behavior

- Hidden/system files and symlinks are ignored.
- Root/overlapping/sensitive directory selections are blocked.
- If a sync is interrupted, already completed files remain valid and compare can be run again to continue remaining work.
- A `sync-history.log` file is appended in the source root with per-file sync records.
