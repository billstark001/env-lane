# env-lane

Workspace-aware dotenv injection for TypeScript and Node.js projects.

`env-lane` makes environment selection explicit across single-package projects and pnpm
workspaces. It resolves a target, loads dotenv files in a predictable order, injects a build
selector such as `ENV_BUILD`, and can inspect, validate, synchronize, sort, or run commands with
the resulting environment.

The workspace publishes:

- `env-lane`: CLI plus a stable convenience facade for the `@env-lane/core` root API.
- `@env-lane/core`: configuration, workspace, dotenv, policy, redaction, and sorting APIs.
- `@env-lane/vault`: optional development-only reversible encrypted dotenv record storage.

Node.js 22 or newer is required.

## Install

~~~bash
pnpm add -D env-lane
~~~

For direct library use:

~~~bash
pnpm add -D @env-lane/core
~~~

Install Vault only when its library or CLI commands are needed:

~~~bash
pnpm add -D @env-lane/vault
~~~

## Quick start

Create `env-lane.config.ts` in the repository root:

~~~ts
import { defineConfig } from 'env-lane';

export default defineConfig({
  selector: {
    envKey: 'ENV_BUILD',
    defaultBuild: 'local',
    builds: ['staging', 'production']
  },
  workspace: {
    aliases: {
      api: 'apps/api',
      web: 'apps/web'
    }
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local'
  }
});
~~~

The default order loads `.env`, then `.env.local` for the local build or
`.env.<build>` for other builds. Later dotenv files override earlier files; `process.env`
overrides dotenv values by default.

~~~bash
env-lane files api --build production
env-lane print api --build production --json
env-lane run api --build production -- pnpm start
env-lane check --target api --build production
~~~

`env-lane` reads `pnpm-workspace.yaml` when present, then falls back to `packages/*` and
`apps/*`. Targets may be package names, relative directories, or configured aliases.

`--cwd` defines config discovery and the base for caller-supplied relative paths. For `run`, place
an explicit `--` after the target/options when forwarding a command; any later `--` belongs to the
child unchanged:

~~~bash
env-lane run api -- node script.mjs -- --child-flag
~~~

`--run-cwd` is separate: it chooses the child working directory (`target`, `root`, or a path
relative to `--cwd`) without changing config discovery.

## Output and automation

Final payloads use stdout. Diagnostics, warnings, progress, and prompts use stderr. JSON mode emits
one JSON document on stdout, including for errors. Secret-like values are redacted unless
`--show-secrets` is explicit.

Use `--non-interactive` in CI and agent workflows. Commands that require approval or conflict
resolution then fail unless all decisions are supplied explicitly. The `run` command accepts text
format only because the child process owns stdout.

## Library

~~~ts
import {
  listEnvFiles,
  resolveInjectedEnv,
  runEnvCheck,
  runEnvSync,
  runWithInjectedEnv,
  sortEnvFilesFromConfig
} from '@env-lane/core';

const files = await listEnvFiles({ target: 'api', build: 'production' });
const resolved = await resolveInjectedEnv({ target: 'api', build: 'production' });
await runEnvCheck('deploy', { build: 'production' });
await runEnvSync('webFromApi', { build: 'production', dryRun: true });
await sortEnvFilesFromConfig('env-lane.config.ts', 'api', 'production');
await sortEnvFilesFromConfig('env-lane.config.ts', 'api', 'production', { check: true });
await runWithInjectedEnv({
  target: 'api',
  build: 'production',
  command: ['node', 'server.js']
});
~~~

Deployment scripts may import the stable Core root API from either `env-lane` or
`@env-lane/core`. Lower-level env-document APIs belong to their dedicated entry point:

~~~ts
import { parseEnvDocument } from '@env-lane/core/env-document';
~~~

See [API and compatibility](docs/api.md) before depending on lower-level helpers.

## Development Vault

`@env-lane/vault` is intentionally not a production secret manager. Encryption does not make a
store or key file safe to publish, and cannot prevent Git, backup, cloud-sync, or logging tools from
copying local files. Prefer a platform Secret Manager, KMS, SOPS, age, or HashiCorp Vault for
production secrets.

~~~bash
env-lane vault encrypt key.aes
env-lane vault encrypt key.aes --dry-run --json
env-lane vault plan key.aes --output restore-plan.json --json
env-lane vault apply key.aes --plan restore-plan.json --yes --non-interactive
~~~

Restore plans contain redacted previews and are bound to current store and dotenv state. Deletes
are not selected by default. Schema v1 stores config-relative portable paths, so a store can move
between Windows and POSIX checkouts without retaining the producer's absolute path. See the
[Vault guide](docs/vault.md) for exclude rules, sync state, selection, conflict handling, history
maintenance, and safety boundaries.

## Documentation

- [CLI reference](docs/cli.md)
- [Configuration reference](docs/config.md)
- [Vault guide](docs/vault.md)
- [API and 0.4 compatibility](docs/api.md)
- [Architecture and invariants](docs/architecture.md)
- [Contributing and releasing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

MIT
