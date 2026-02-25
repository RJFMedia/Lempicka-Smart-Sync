# Changelog

All notable changes to this project are documented in this file.

## [1.0.3] - 2026-02-25

### Fixed
- Stabilized publish-time code-signing identity handling to avoid invalid `CSC_NAME` values.
- Added stronger publish preflight validation for signing/notarization credentials.

## [1.0.2] - 2026-02-25

### Added
- Notarized macOS release workflow integrated with `npm run publish`.
- Keychain profile support and local publish credential configuration for GitHub + Apple notarization.

### Changed
- macOS packaging remains arm64-only and hardened for distribution.

## [1.0.1] - 2026-02-25

### Changed
- Slimmed packaged app size by excluding non-runtime project artifacts from the bundled app.
- Updated mac packaging targets to arm64-only.

## [1.0.0] - 2026-02-24

### Added
- Initial release of Lempicka Smart Sync.
- Directory comparison and sync workflow for versioned source files to unversioned destination files.
- Sync progress, cancellation, recovery handling, and sync history UI.
