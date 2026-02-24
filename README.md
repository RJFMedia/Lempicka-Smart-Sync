# Lempicka Smart Sync

A desktop app to compare two directory trees and sync versioned files from the left tree into the right tree.

## Behavior

- Scans the left and right trees recursively.
- Left-side files may be versioned as `name_v###.ext`.
- A versioned file maps to the right-side target `name.ext` (same relative directory).
- When multiple left candidates map to the same target, the highest version number wins.
- A file is copied only when the chosen left candidate size differs from the right target size, or when the right target is missing.
- During copy, the destination name uses the stripped form (`_v###` removed), replacing any existing target file.

## Run

1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

## Build Standalone macOS App

1. Install dependencies:

```bash
npm install
```

2. Build a standalone `.app` bundle:

```bash
npm run build
```

## UI flow

1. Choose left and right directories.
2. Click `Compare` to list files that will be replaced/copied.
3. Click `Sync` to perform copy/rename operations.
4. Watch the progress bar during sync.
