# Lempicka Smart Sync

A desktop app to compare two directory trees and sync versioned files from the left tree into the right tree.

## Behavior

- Scans the left and right trees recursively.
- Left-side files may be versioned as `name_v###.ext`.
- A versioned file maps to the right-side target `name.ext` (same relative directory).
- When multiple left candidates map to the same target, the highest version number wins.
- A file is copied only when the chosen left candidate size differs from the right target size, or when the right target is missing.

## Run Locally

```bash
npm install
npm start
```

## Build Local macOS App

```bash
npm run build
```
