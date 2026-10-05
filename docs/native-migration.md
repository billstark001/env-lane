# Rust rewrite status (0.5.0)

Version 0.5.0 uses a Rust CLI and Core engine, a Node-API binding for stable JS imports, and a process plugin boundary. The frozen 0.4.2 oracle remains a reference for stable Core behavior and Vault persisted data; the 0.5.0 process contract documents intentional fixes to exit status, stdio, and signals.

## Runtime paths

- `env-lane` from npm runs the installed native binary. Its install script copies the platform binary to the npm bin path. Direct standalone binaries use the same native Core code. A standalone archive keeps its `plugins/` tree beside the executable.
- JSON, JSONC, JSON5, YAML, and TOML main/Vault files are read and validated by Rust. They need no Node. JS/TS configuration uses `@env-lane/config-compat` to evaluate and cache source JSON; Rust performs schema validation. Dynamic sources need `env-lane-config run` for a fresh envelope.
- The native CLI reads configured plugin package metadata. Vault is registered by `vault: { enabled: true }` and supplied by `@env-lane/vault`. The plugin process parses all Vault command options and owns its config schema. The host has no Vault command parser, peer check, or sibling-binary lookup.
- Stable `@env-lane/core` and `@env-lane/vault` imports still use Node as their application runtime. Their business operations go through the native binding; Vault operations then use the same plugin package resolver and process protocol. `@env-lane/vault/cli` remains a separate, stable Commander adapter for embedding.

The old `plugins: []` registration, `env-files`/`env-json` command aliases, deprecated root exports, Vault config path guessing, and Vault exclude shorthand are removed. See [API migration](api.md) and [plugin protocol](native-plugin-protocol.md).

## Verification

`pnpm check` runs lint, TypeScript, package builds, synthetic Vitest coverage, package-entry smoke checks, and 0.5.0 plugin conformance. `pnpm rust:check` runs rustfmt, Clippy, Rust tests, and differential checks for the stable document, sort, Vault crypto/store/config contracts. Process conformance uses synthetic children and the [0.5.0 process contract](../compat/contracts/v0.5.0-process.json). The local npm layout test verifies package discovery and native Vault startup with no Node on `PATH`. Cross-platform release jobs build eight targets and package standalone archives with checksums. The 16 platform npm packages are generated from the target table and staged binaries during release; neither native nor Vault platform package directories are tracked.

The Vault record format remains v1 for new writes and reads v0/v1. The 0.4.2 release remains the rollback package. Production dotenv values and keys are not used by these tests. The three downstream projects are inspected read-only; any writable canary belongs in a separate controlled environment.
