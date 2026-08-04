# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.4.2] - 2026-08-04

### Changed

- Treat missing managed dotenv files as empty during Vault encrypt by default, so removing a file
  produces the same delete tombstones as emptying it. Use `--missing-files skip` or the library
  `missingFiles: 'skip'` option to retain the previous skip behavior.
- Select Vault delete entries by default. Use `--no-approve-deletes` or the library
  `approveDeletes: false` option to opt out.
- Require `@env-lane/vault ^0.4.2` as the optional CLI peer and validate a runtime CLI API
  handshake, preventing 0.3.x or earlier 0.4.x Vault adapters from silently running with
  incompatible command semantics.

### Fixed

- Allowed a resolved missing-file conflict to converge by recording its delete tombstones and sync
  baseline while leaving the local file absent. Applying deletes continues to preserve existing
  dotenv files, including when the result is empty.
- Return `VAULT_VERSION_UNSUPPORTED` when an incompatible optional Vault peer is forced into the
  install instead of loading its legacy registration API.

## [0.4.1] - 2026-08-04

### Added

- Added configurable Vault restore preview redaction (`full`, URL-aware `partial`, or `none`),
  optional prefix/suffix hints, and configurable wrapping for the interactive restore
  selection list, with matching CLI overrides.
- Added general JWT and PASETO recognition, heuristic high-entropy value detection, and
  centralized locally generated synthetic credential fixtures covering common service and wallet
  formats.
- Added an eight-character redaction floor so shorter values and URL components remain visible.

### Changed

- Changed interactive restore choices to show current and Vault previews in aligned key columns,
  cap displayed keys at 64 characters, display ten lines when the terminal permits, disable
  navigation wrapping by default, and support `Esc`/`q` cancel.

### Fixed

- Fixed no-argument CLI invocation so it prints the generated command help instead of wrapping
  Commander's internal help signal as `CLI_ARGUMENT_ERROR: (outputHelp)`.
- Fixed partial restore preview false positives for ordinary RPC endpoints, public-key PEM values,
  public wallet addresses, and provider-name lists.
- Skipped interactive selection when a restore plan contains no selectable changes.

## [0.4.0] - 2026-08-04

### Added

- Added the stable `@env-lane/core/env-document` feature entry point and the optional
  `@env-lane/vault/cli` adapter entry point for both ESM and CommonJS consumers.
- Added redacted, digest-bound Vault restore plans, editable approval documents, partial entry
  selection, delete approval, and `--fail-on conflict|change|warning` automation contracts.
- Added stable public CLI error codes, structured error details, default secret redaction, and
  build-time tests against the published ESM, CommonJS, declaration, and real CLI entry points.
- Added operation-level Vault locking around store, sync-state, and dotenv transactions while
  retaining atomic file replacement and rewrite digest checks.
- Added no-write sort drift checks through `sort --check`, `sort-file --check`, and the Core
  `check: true` option. CLI checks exit with status 1 when a selected file would change.
- Added `vault encrypt --dry-run` and the Vault `dryRun: true` option to preview selected records,
  conflicts, and changes without creating or modifying the store, sync state, or output directory.

### Changed

- Curated the three package export boundaries around stable use cases and feature entry points.
- Organized production code and tests into coarse-grained `domain`, `application`, `adapters`,
  and `presentation`/`cli` layers without increasing the number of implementation or test files.
- Made Core and Vault library APIs terminal-independent; CLI payloads use stdout while diagnostics,
  warnings, and prompts use stderr.
- Split the repository documentation into focused CLI, configuration, Vault, API, architecture,
  and contributor guides.
- Changed schema v1 Vault records to persist portable, Vault-config-relative file paths with `/`
  separators. Runtime paths remain absolute; legacy versionless/v0 absolute paths remain readable
  through the existing optional remapping behavior.
- Normalized caller-relative paths once at CLI/API boundaries, passed nominal absolute paths
  through private Core and Vault APIs, and moved child-process execution into a dedicated adapter.
- Updated CI to current Node 24-based Actions, standardized on pnpm 11, verified both the minimum
  Node 22 and Node 24 runtimes, and made npm publishing tag-driven with release metadata checks.

### Fixed

- Bound Vault approval decisions to the complete, freshly recomputed restore plan so entries cannot
  be omitted by editing both a plan entry and its decision.
- Resolved Vault configuration, store, and sync paths consistently from `--cwd`.
- Prevented concurrent Vault operations from losing store updates or interleaving sync-state and
  dotenv commits.
- Redacted secret-like values in JSON output unless `--show-secrets` is explicit.
- Corrected `--fail-on` to evaluate the selected plan and final decisions rather than editable
  approval summaries or unselected changes.
- Preserved child command argument boundaries for invocations such as
  `env-lane run api -- node script.mjs -- --child-flag`; a child-owned `--` no longer causes the
  target to be reordered into the child arguments.
- Made `sort --cwd` and `sort-file --cwd` consistently control config discovery and caller-relative
  paths. Explicit relative config paths resolve from `--cwd`, while configured sort `baseDir`
  values resolve from the project root.
- Resolved relative `--run-cwd`, `--vault-config`, Vault key-file, and `--sync-dir` arguments from
  the invocation `--cwd` before entering their application workflows.

### Deprecated

- Deprecated Core configuration internals, resolved-input helpers, the Node file adapter, sort
  planner internals, and workspace orchestration internals from the package root.
- Deprecated env-document symbols from the Core package root; import them from
  `@env-lane/core/env-document` instead.
- Deprecated `registerVaultCommands` from the Vault package root; import it from
  `@env-lane/vault/cli` instead.
- Deprecated Vault cryptographic implementation helpers from the package root. These compatibility
  exports remain in 0.4.x and are planned for removal in the next intentionally breaking release.

### Removed

- Removed `cli.aliases` and configured command alias expansion. The 0.3.0 release introduced this
  feature; 0.4.0 is the release that formally removes it. Built-in `env-files` and `env-json`
  aliases are unchanged.

---

## [0.3.0]

### Added

- Added recursive object value redaction (`redactObject`) with advanced detection in `@env-lane/core`.
- Added Shannon entropy checking for secret detection with configurable options (`minEntropyLength`, `entropyThreshold`, `detectValues`).
- Added key allowlist and denylist pattern matching (`allowListKeys`, `denyListKeys`) in core redaction options.
- Added matching patterns for common developer credentials (e.g. GitHub PATs, Slack/Stripe/Claude keys) and query-embedded URL credentials.
- Added `dotenv` options: `eol` ('auto', 'lf', 'crlf') and `preserveBOM` (boolean) to control how environment files are written.
- Added `output.prefix` configuration and a global `--no-prefix` CLI option to toggle console log prefixes.
- Added target sort option `create` (boolean) to allow creating missing target env files from an
  existing template.
- Added CLI command aliases via the `cli.aliases` configuration.
- Added `--vault-config <file>`, `--no-auto-remap` (`autoRemapPaths`), and `--allow-unmanaged` (`allowUnmanaged`) configuration options and flags to the vault module.

### Changed

- Updated vault commands (`encrypt`, `plan`, `decrypt`, `prune`) to take `<keyFile>` as a positional parameter, using `--vault-config` or auto-loading instead of requiring the config file as a positional argument.
- Changed the default vault configuration file name from `env-lane.vault.json` to `env-lane.vault`.
- Standardized internal config loading under a generic `loadConfigWithC12` utility in `@env-lane/core`.
- Restructured CLI console logging and format outputs via central `ctx.formatAndLog` and `ctx.mergeOptions`.

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
- Unified runtime and editing workflows on the shared line-level env document model while retaining
  `dotenv`-compatible effective values.

### Fixed

- Preserved vault restore behavior when appending restored keys, avoiding extra blank lines before vault additions.
- Returned `sort` from loaded vault config instead of accepting the field in schema but dropping it from the resolved config.
- Kept `legacy/` ignored so local legacy reference scripts are not committed.

---

## [0.1.0]

Initial release.

---
