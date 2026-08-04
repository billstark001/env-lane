# CLI reference

Install the executable package:

~~~bash
pnpm add -D env-lane
~~~

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

Final payloads use stdout. Diagnostics, warnings, progress, and prompts use stderr. JSON mode emits
exactly one JSON document on stdout, including for errors. Expected public failures expose stable
`error.code` values and may include structured `error.details`.

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
pnpm add -D @env-lane/vault
~~~

| Command | Purpose |
| --- | --- |
| `vault encrypt <keyFile>` | Append local dotenv changes to the encrypted store. |
| `vault plan <keyFile>` | Build a restore plan or approval document with configurable redaction. |
| `vault decrypt <keyFile>` | Preview or apply selected Vault values. |
| `vault apply <keyFile>` | Apply an approval document after freshness validation. |
| `vault sanitize <keyFile>` | Remove history covered by local-only exclude rules. |
| `vault prune <keyFile>` | Compact selected history. |

Selection options on encrypt, plan, and decrypt include `--file`, `--key`, `--include`,
`--exclude`, `--only`, and `--approve-deletes`. Conflict policy is one of `abort`,
`keep-local`, or `take-vault`.

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
  --conflicts take-vault \
  --approve-deletes
~~~

`--fail-on conflict|change|warning` returns status 2 when the selected result matches the
condition. Ordinary command errors return status 1.

See [Vault](vault.md) for the full workflow and safety model.

## Configured command aliases

The former `cli.aliases` config feature was introduced in 0.3.0 and removed in 0.4.0. Use package
scripts or a dedicated shell/Node script for parameterized command macros. Built-in `env-files`
and `env-json` aliases remain available for `files` and `print`.
