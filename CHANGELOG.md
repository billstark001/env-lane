# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0]

### Added

- Added Biome as the workspace formatter/linter and wired `pnpm lint` to `biome check .`.
- Added `env-lane vault plan <config> <keyFile>` for restore previews.
- Added `env-lane vault decrypt --yes` for non-interactive restore approval.
- Added vault restore planning with add/modify/delete/identical summaries and store read statistics.

### Changed

- Vault restore now preserves comments, blank lines, unmanaged variables, `export` prefixes, BOMs, newline style, and final newline behavior.
- Vault store loading now remaps records from previous checkout paths to current `config.envFiles` paths when relative paths match.
- Env sorting now follows the template while preserving preambles, suffixes, variable-leading comments, duplicate key groups, missing keys as commented entries, and extra keys.
- CLI `print` defaults to dotenv keys plus selector and requires `--include-shell` to dump the full shell environment.
- CLI `files all` and `check [target|all]` support workspace-wide operation.

### Fixed

- Fixed missing Biome dependency.
- Fixed vault warning CLI behavior so disabling warnings remains config/API-only.
- Fixed Commander pass-through setup for `run`.
- Fixed TypeScript/Zod/picomatch compatibility issues in the workspace build.

---
