# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0]

### Added

- Added optional vault sync state with conflict detection for `vault encrypt`, `vault plan`, and `vault decrypt`.
- Added vault history pruning with `vault prune`, including age-based and recent-count pruning while preserving the latest record by default.
- Added CLI registrars so core/sort commands are registered by the CLI package and vault commands are registered by `@env-lane/vault`.
- Added a shared env document parser/writer for editing-oriented workflows, now used by sort, vault restore, and env sync.
- Added configured env policy checks via `env-lane check --policy <name>` and `runEnvCheck()`.
- Added configured env value sync via `env-lane sync <name>` and `runEnvSync()`.
- Added selector build validation with `selector.buildValidation`, defaulting to warnings for builds outside `selector.builds`.
- Added a shared env file variant model for default/no-suffix env files.

### Changed

- Raised the required Node.js version to 22 and updated `commander` to v15.
- Bumped all workspace package versions to 0.2.0.
- Unified CLI output format defaults around `text`; commands now use configured output format unless `--format` or `--json` is provided.
- Replaced the old positional `check [target]` command shape with explicit `env-lane check --target <target>` for built-in dotenv selector checks and `env-lane check --policy <name>` for configured policy checks.
- Renamed the configured env sync command from `sync-env` to `sync`.
- Generalized `localBuildName` / `localOverrideFile` so local override mapping applies to any dotenv order pattern containing `{build}`.
- Standardized env file writes through the shared env document writer while preserving vault restore layout compatibility.
- Documented the intentional parser split: runtime dotenv injection and selector checks use `dotenv.parse()`, while editing workflows use the structured env document parser/writer.

### Fixed

- Preserved vault restore behavior when appending restored keys, avoiding extra blank lines before vault additions.
- Returned `sort` from loaded vault config instead of accepting the field in schema but dropping it from the resolved config.
- Kept `legacy/` ignored so local legacy reference scripts are not committed.

---

## [0.1.0]

Initial release.

---
