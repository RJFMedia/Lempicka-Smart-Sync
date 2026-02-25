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

## Publish Notarized macOS Updates

`npm run publish` now expects both GitHub release credentials and Apple notarization credentials.

1. Install a valid `Developer ID Application` certificate in Keychain Access.
2. Copy `config/publish.local.example.yml` to `config/publish.local.yml`.
3. Fill in `github` values and one `apple` notarization method.
4. Optionally set `signing.cscName` if auto-discovery does not pick your cert.
5. Validate config without publishing:

```bash
node scripts/publish-from-config.js --dry-run
```

6. Publish:

```bash
npm run publish
```

### Recommended Notarization Auth (Keychain Profile)

Store notary credentials in macOS Keychain, then reference only the profile name in YAML:

```bash
xcrun notarytool store-credentials "lempicka-notary" \
  --apple-id "you@example.com" \
  --team-id "TEAMID1234" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

Then set:

```yaml
apple:
  keychainProfile: lempicka-notary
```
