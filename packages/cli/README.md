# env-lane

On `rewrite/rust-native`, this package installs a native platform binary for the `env-lane`
command. The existing Node/Commander source entry remains for compatibility tests and JavaScript
imports continue through the public facade. Stable Core and Vault operations reach Rust through
`@env-lane/native`. See [native migration](../../docs/native-migration.md).

CLI for workspace-aware dotenv injection and optional development vault helpers.

```bash
pnpm add -D env-lane --allow-build=env-lane
```

```bash
env-lane packages
env-lane files api --build production
env-lane print api --build production --format json
env-lane run api --build production -- pnpm start
env-lane check --target api --build production --require-override
env-lane check --policy deploy --build production
env-lane sync webFromApi --build production --dry-run
env-lane sort api production --config env-lane.config.json
env-lane sort api production --check
env-lane vault encrypt key.aes --dry-run --json
```

Final command payloads use stdout; diagnostics use stderr. `--json` emits one JSON document on stdout. The `run` command accepts text only because its child owns stdout. Use `--non-interactive` together with explicit approval and conflict policies for agents and CI.

`--cwd` controls config discovery and caller-relative CLI paths. `--run-cwd` only chooses the child
working directory and defaults to the resolved target. Prefer an explicit child boundary; later
separators remain child arguments:

```bash
env-lane run api -- node script.mjs -- --child-flag
```

`sort --check` and `sort-file --check` do not write and exit with status 1 on drift. Vault
`encrypt --dry-run` previews selected record changes without creating or updating the encrypted
store, sync state, or output directories.

The package intentionally re-exports the stable `@env-lane/core` root API for configuration files
and deployment scripts. This convenience facade remains stable. Feature entry points such as
`@env-lane/core/env-document` are available only from their owning package.

Vault commands in the npm installation require the optional `@env-lane/vault` peer. The installer
records its version for the native CLI's `VAULT_NOT_INSTALLED` and `VAULT_VERSION_UNSUPPORTED`
checks; the binary reads the live peer manifest when Vault is installed later. The JavaScript
`@env-lane/vault/cli` adapter remains available for Commander integrations.
Executable JS/TS configuration needs an `@env-lane/config-compat` cache; JSON/YAML is read
directly.

Configured `cli.aliases` were introduced in 0.3.0 and removed in 0.4.0. Use package scripts for
command macros.

See the [CLI reference](https://github.com/billstark001/env-lane/blob/main/docs/cli.md) and
[API compatibility guide](https://github.com/billstark001/env-lane/blob/main/docs/api.md).
