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

## Auto-Update Publishing via GitHub Releases

### One-time setup

1. Create or connect a GitHub repository and set `origin`:

```bash
git remote add origin git@github.com:YOUR_USER_OR_ORG/Lempicka-Smart-Sync.git
# or update existing origin
# git remote set-url origin git@github.com:YOUR_USER_OR_ORG/Lempicka-Smart-Sync.git
```

2. Create a GitHub personal access token with repository write access.
- Fine-grained token permissions should include at least `Contents: Read and Write`.

3. Create your local credentials file from the template:

```bash
cp config/publish.local.example.yml config/publish.local.yml
```

4. Edit `config/publish.local.yml` and fill in your real values:

```yaml
github:
  token: ghp_your_real_token
  owner: YOUR_USER_OR_ORG
  repo: Lempicka-Smart-Sync
```

`config/publish.local.yml` is gitignored and will not be committed.

### Per-release workflow

1. Commit your app changes:

```bash
git add -A
git commit -m "Describe your release changes"
```

2. Bump the app version (creates a version commit and git tag):

```bash
npm version patch
# or npm version minor / npm version major
```

3. Push commits and tags:

```bash
git push origin main --follow-tags
```

4. Publish update artifacts to GitHub Releases:

```bash
npm run publish
```

That single command reads your local YAML credentials, builds macOS release artifacts, and uploads the update files (`dmg`, `zip`, `latest-mac.yml`, `blockmap`) to GitHub Releases for in-app auto-update.

## Notes

- Auto-updates are enabled only in packaged builds (`app.isPackaged`).
- `release/` output is gitignored.
