# Native rewrite migration and verification

This branch is an implementation checkpoint against the frozen env-lane 0.4.2 contract. It is
not a published release. Keep the existing 0.4.2 package as the rollback version until the
platform package and package-manager installation gates have passed.

## Configuration

The standalone Rust binary reads JSON, JSONC, JSON5, YAML, and TOML directly:

~~~bash
cargo run --locked -p env-lane-cli -- --cwd . packages
~~~

An existing static TypeScript or JavaScript configuration can be compiled separately:

~~~bash
pnpm add -D @env-lane/config-compat
pnpm exec env-lane-config compile --kind main --cwd .
pnpm exec env-lane-config compile --kind vault --cwd .
~~~

The resulting `.env-lane-cache/` envelope is reused while its source and local imports are
unchanged. For a dynamic configuration, use `env-lane-config run --cwd . <command>`; this
starts Node for each invocation. Neither route caches dotenv values or Vault keys; the envelope
does contain the resolved configuration object. A declarative configuration is the simplest way
to use the standalone binary without Node. The compiler accepts
the existing Vault exclude aliases and shorthand, writing canonical `files`/`keys` arrays for
Rust. Hand-written native configuration should use the canonical array form.

## API and commands

The public `env-lane`, `@env-lane/core`, and `@env-lane/vault` import names and ESM/CommonJS
entries remain. Stable application operations call a Node-API Rust binding; JavaScript keeps
configuration evaluation, diagnostics, Commander integration, types, and deprecated exports.
The `@env-lane/core/env-document` facade also calls Rust for parsing, formatting, and patch
planning while preserving its existing `Map` results and Node file-writing API.
Vault restore callbacks are converted to decisions before native apply. Encrypt callbacks use a
native candidate preview with frozen dotenv documents. JavaScript gathers callback decisions
under the operation lock, then Rust applies those decisions to the frozen snapshot. A callback
that edits a dotenv file cannot change the values committed by the current operation.
The npm `env-lane` package installs the platform binary at its bin path; the source Commander
entry remains for compatibility tests. Vault is an optional native plugin executable shipped by
`@env-lane/vault`. The installer records the optional Vault peer state so native Vault commands
keep the prior missing/version error codes. Under `node_modules`, the binary also checks the
live peer manifest when Vault is installed later without rerunning the CLI install script.
Native plugin registration and wire details are in
[Native plugin protocol](native-plugin-protocol.md).
On pnpm 12, approve this package's install script with
`pnpm add -D env-lane --allow-build=env-lane` or an `allowBuilds: { env-lane: true }` entry in the
consumer's `pnpm-workspace.yaml`. Installation without that approval is rejected by pnpm before
the binary can be copied. The standalone binary requires no package-manager install script.

## Verification and remaining release gates

`pnpm check` exercises the JS tests, frozen fixtures, built package entries, and process
checks. `pnpm rust:check` runs Rust lint/tests, cross-language differential suites, a POSIX Vault
terminal test, and a simulated native npm installation. The
release workflow builds eight native addon/CLI platform pairs, verifies package contents, and
stages standalone release assets with a `SHA256SUMS` file.
Cross-platform jobs, published platform-package installation across npm/pnpm/yarn, a new
publishable version/tag, and downstream canaries still require
validation. Disposable local npm/pnpm tarball installs exercised the direct bin using a local
binary override; a separate simulation verified the optional Vault peer gates.
No npm publication has occurred from this branch.

The durable Vault record format remains schema v1 for new writes and supports v0/v1 reads.
Therefore 0.4.2 can read native-written records; confirm this in a disposable copy before a
real rollback. Do not place actual dotenv files, keys, or stores in fixtures or the cache.
