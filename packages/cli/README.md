# env-lane

This package installs a native platform binary for the `env-lane` command. JavaScript imports
continue through the stable Core facade and `@env-lane/native` binding. See
[native migration](../../docs/native-migration.md).

CLI for workspace-aware dotenv injection and optional development vault helpers.

```bash
pnpm add -D env-lane
```

For pnpm, approve this package's install script with `allowBuilds: { env-lane: true }` in
`pnpm-workspace.yaml` before installing. A blocked script leaves a failure stub at the command
path; it does not install a binary for another operating system.

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

Final command payloads use stdout; diagnostics use stderr. Outside `run`, `--json` emits one JSON document on stdout. The `run` command accepts text only because its child owns stdout; its own errors use stderr. Use `--non-interactive` together with explicit approval and conflict policies for agents and CI.

`--cwd` controls config discovery and caller-relative CLI paths. `--run-cwd` only chooses the child
working directory and defaults to the resolved target. Prefer an explicit child boundary; later
separators remain child arguments:

```bash
env-lane run api -- node script.mjs -- --child-flag
```

The child inherits all three byte streams. Normal exit status passes through; a missing command
returns 127 and another startup failure returns 126. On POSIX, the runner retains the child's
termination signal and forwards a received SIGINT/SIGTERM to the child process group in non-TTY
runs.

`sort --check` and `sort-file --check` do not write and exit with status 1 on drift. Vault
`encrypt --dry-run` previews selected record changes without creating or updating the encrypted
store, sync state, or output directories.

The package intentionally re-exports the stable `@env-lane/core` root API for configuration files
and deployment scripts. This convenience facade remains stable. Feature entry points such as
`@env-lane/core/env-document` are available only from their owning package.

Vault commands require `@env-lane/vault` and `vault: { enabled: true }` in the main config.
The binary reads the package's `envLanePlugin` manifest through the generic plugin resolver.
The JavaScript `@env-lane/vault/cli` adapter remains available for embedded Commander integrations.
Executable JS/TS configuration needs an `@env-lane/config-compat` cache; JSON/YAML is read
directly.

Use package scripts for command macros. The old `env-files` and `env-json` command aliases were
removed in 0.5.0.

See the [CLI reference](https://github.com/billstark001/env-lane/blob/main/docs/cli.md) and
[API compatibility guide](https://github.com/billstark001/env-lane/blob/main/docs/api.md).
