# CLI reference

## Native executable on the rewrite branch

`cargo run --locked -p env-lane-cli -- <command>` exercises the standalone Rust CLI. It implements
the Core commands below and `vault encrypt|plan|decrypt|apply|sanitize|prune`. Native declarative
configuration runs without Node. For executable JS/TS configuration, compile a cache first or use
`env-lane-config run <command>` for dynamic configuration; see [configuration](config.md).

Vault `decrypt` offers a terminal selection list when `--yes` is omitted. Arrow keys move, Space
toggles a row, `a` selects all, `i` inverts, Enter proceeds to confirmation, and Esc or `q`
cancels. `--prompt-loop` and `--no-prompt-loop` control wrapping. Use `--yes` with an explicit
`--conflicts keep-local|take-vault` policy for non-interactive restores. The native CLI writes
prompts and diagnostics to stderr and structured results to stdout.

The npm `env-lane` package installs the platform binary at its bin path. Installation uses Node
to select the binary; invoking the installed command executes Rust directly. The packed bin path
contains only a failure stub, so an installation that blocks lifecycle scripts fails explicitly
instead of running the release runner's binary. Enable the package's install script when adding
`env-lane`. Plugins are resolved from
enabled root config registrations and their package `envLanePlugin` metadata. Vault uses the same
resolver as other plugins.

Install the executable package:

~~~bash
pnpm add -D env-lane
~~~

pnpm blocks unapproved dependency install scripts. Add `env-lane: true` under `allowBuilds` in
`pnpm-workspace.yaml` before installation, or approve the package with `pnpm approve-builds` and
reinstall. The install script is required for the native npm command path.

## Global options

Global options may be placed before or after a subcommand:

| Option | Meaning |
| --- | --- |
| `-c, --config <file>` | Main env-lane config file. |
| `-b, --build <name>` | Build selector value. |
| `--cwd <dir>` | Base directory for config discovery and relative CLI path arguments. |
| `--format <text|json|dotenv>` | Output format. Dotenv is supported only by `print`. |
| `--json` | Shorthand for `--format json`. |
| `--non-interactive` | Disable prompts and require explicit decisions. |
| `--no-prefix` | Remove diagnostic scope prefixes. |

Final payloads use stdout. Diagnostics, warnings, progress, and prompts use stderr. Except for
`run`, JSON mode emits exactly one JSON document on stdout, including for errors. `run` reserves
stdout for its child and reports its own errors on stderr, even if `--json` is requested. Expected
public failures expose stable `error.code` values and may include structured `error.details`.

Secret-like values from `print` and `sync` are redacted by default. Use `--show-secrets` only
when the destination is trusted.

## Workspace and dotenv commands

| Command | Purpose |
| --- | --- |
| `env-lane packages` | List discovered workspace packages. |
| `env-lane resolve-target <target>` | Resolve a name, path, or configured alias. |
| `env-lane files [target]` | List dotenv files in injection order; `all` lists every package. |
| `env-lane print <target>` | Print the resolved environment and source information. |
| `env-lane run <target> [--] <command...>` | Run a child with the resolved environment. |
| `env-lane check --target <target>` | Check selector and required dotenv invariants. |
| `env-lane check --policy <name>` | Run a configured policy. |
| `env-lane sync <name>` | Run a configured value synchronization. |

Examples:

~~~bash
env-lane packages --json
env-lane files api --build production --require-override
env-lane print api --build production --json
env-lane print api --format dotenv --no-process-env
env-lane run api --build production --run-cwd root -- pnpm test
env-lane run api -- node script.mjs -- --child-flag
env-lane check --policy deploy --build production
env-lane sync webFromApi --build production --dry-run --json
~~~

`run` accepts text output only because the child process owns stdout. Options after the child
boundary are passed through unchanged, including names such as `--json`, `--config`, and
`--format`. Prefer the explicit boundary after the target/options; a later standalone `--` remains
part of the child command. A path passed to `--run-cwd` is resolved from `--cwd`; `target` (the
default) and `root` select the resolved package directory and workspace root respectively.
`--run-cwd` changes only the child working directory, while `--cwd` controls config discovery and
all caller-relative CLI paths.

The child inherits stdin, stdout, and stderr without text conversion or buffering. `--quiet`
suppresses the run summary. A normal child exit code passes through unchanged. A missing executable
exits 127 (`RUN_COMMAND_NOT_FOUND`); another startup failure exits 126
(`RUN_SPAWN_FAILED`). On POSIX, a child signal terminates the runner with the same signal.

When all three streams are non-TTY, the runner creates a dedicated child process group and forwards
received SIGINT/SIGTERM to that group. A requested stop allows up to five seconds for the entire
group to finish, even if the direct child exits first, then sends SIGKILL to remaining members.
Further signals are forwarded during this grace period without extending it. The runner terminates
with the first requested signal. Ordinary child completion does not trigger group cleanup, and
descendants that deliberately leave the group are outside this cleanup boundary.

Interactive children keep the inherited process group and terminal stdin access. When that group
owns the foreground terminal, Ctrl+C already reaches the child, so the runner does not forward
SIGINT again. This also applies to SIGINT sent only to the runner PID: portable signal APIs cannot
reliably distinguish it from terminal Ctrl+C. Use terminal Ctrl+C or signal the child directly in
that case. SIGTERM still forwards to the direct child. Interactive timeout cleanup sends SIGKILL
only to the direct child, never to the shared terminal group. See the
[0.5.0 process contract](../compat/contracts/v0.5.0-process.json).

`check` requires exactly one of `--target` or `--policy`.

## Sorting commands

Sort one file against a template:

~~~bash
env-lane sort-file apps/api/.env apps/api/.env.example
env-lane sort-file apps/api/.env apps/api/.env.example --check
~~~

Sort configured targets:

~~~bash
env-lane sort
env-lane sort api
env-lane sort api production
env-lane sort api production --config env-lane.config.ts
env-lane sort api production --check
~~~

The config path is an option, not a positional argument. `key` defaults to `all`, and
`envSuffix` defaults to `all`. Both commands support `--eol <auto|lf|crlf>` and
`--no-preserve-bom`. Both also support `--check`, which reports drift without creating or changing
files and exits with status 1 when any selected file would change.

For `sort-file`, relative env and template arguments are resolved from `--cwd`. For `sort`,
default config discovery starts from `--cwd`, and an explicit relative `--config` path is also
resolved from `--cwd`. Paths declared inside the sort config follow the configuration rules below.

When `sort.create` is true, a missing target env file may be created from an existing template.
A missing template is always an error.

## Vault commands

Vault commands require `@env-lane/vault`:

~~~bash
pnpm add -D env-lane@^0.5.0 @env-lane/vault@^0.5.0
~~~

Enable Vault in the main configuration with `vault: { enabled: true }`. The package is read via
its `envLanePlugin` manifest and its command parser runs inside the plugin process.

| Command | Purpose |
| --- | --- |
| `vault encrypt <keyFile>` | Append local dotenv changes to the encrypted store. |
| `vault plan <keyFile>` | Build a restore plan or approval document with configurable redaction. |
| `vault decrypt <keyFile>` | Preview or apply selected Vault values. |
| `vault apply <keyFile>` | Apply an approval document after freshness validation. |
| `vault sanitize <keyFile>` | Remove history covered by local-only exclude rules. |
| `vault prune <keyFile>` | Compact selected history. |

Selection options on encrypt, plan, and decrypt include `--file`, `--key`, `--include`,
`--exclude`, `--only`, `--approve-deletes`, and `--no-approve-deletes`. Deletes are selected by
default. Conflict policy is one of `abort`, `keep-local`, or `take-vault`.

Vault encrypt treats a missing managed dotenv file as empty by default: active Vault entries for
that file become delete candidates, while env-lane leaves the local file absent. Pass
`--missing-files skip` to retain the Vault entries and skip the missing file instead.

`vault plan`, `vault decrypt`, and `vault apply` accept `--redaction full|partial|none` and
`--reveal <start:end>` as one-off overrides of `restore.redaction` and `restore.reveal`.
`--no-reveal` suppresses configured value hints. Interactive decrypt also accepts `--prompt-loop`
and `--no-prompt-loop`; wrapping defaults to off. The selector shows current/Vault previews in
each row, displays ten lines when the terminal permits, and accepts `Esc` or `q` to cancel.

`vault encrypt --dry-run` returns the same selected changes and record counts without creating or
modifying the encrypted store, sync state, or output directories. Combine it with `--json` for CI
or tooling and `--fail-on change` when drift should fail the command.

For unattended restore, make every policy explicit:

~~~bash
env-lane vault decrypt key.aes \
  --yes \
  --non-interactive \
  --conflicts take-vault
~~~

`--fail-on conflict|change|warning` returns status 2 when the selected result matches the
condition. Ordinary command errors return status 1.

See [Vault](vault.md) for the full workflow and safety model.

Plugin command names are their root config field names. The `env-files` and `env-json` aliases
were removed in 0.5.0; use `files` and `print`.
