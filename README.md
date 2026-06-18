# env-lane

Workspace-aware dotenv injection for TypeScript and Node.js projects.

`env-lane` keeps environment selection explicit, repeatable, and friendly to pnpm monorepos. It discovers workspace packages, resolves a target app or package, loads dotenv files in a predictable order, injects a selector such as `ENV_BUILD`, and can run commands with the resolved environment.

The repository publishes three packages:

- `env-lane`: the CLI package. It also re-exports the public APIs from the core package.
- `@env-lane/core`: workspace discovery, config loading, dotenv resolution, selector checks, command execution, redaction, and env-file sorting.
- `@env-lane/vault`: development-only reversible encrypted dotenv record storage. It is intentionally unsafe for production secret management.

## Why

Most projects eventually grow a mix of `.env`, `.env.local`, `.env.staging`, package-specific overrides, CI shell variables, and one-off scripts. `env-lane` makes that behavior visible:

- one selector key controls the active build lane
- workspace targets can be addressed by package name, directory, or alias
- dotenv files are listed before they are injected
- shell environment overrides are tracked in the resolved source map
- checks catch selector variables committed to dotenv files
- CI can require the selected override file to exist

## Install

For CLI usage:

```bash
pnpm add -D env-lane
```

For direct library usage:

```bash
pnpm add -D @env-lane/core
```

Install the vault package only when you need the optional development vault helpers or `env-lane vault` commands:

```bash
pnpm add -D @env-lane/vault
```

`env-lane` requires Node.js 22 or newer.

## Quick Start

Create `env-lane.config.ts` in the repository root:

```ts
import { defineConfig } from '@env-lane/core';

export default defineConfig({
  selector: {
    envKey: 'ENV_BUILD',
    defaultBuild: 'local'
  },
  workspace: {
    packageGlobs: ['apps/*', 'packages/*'],
    aliases: {
      api: '@acme/api',
      web: '@acme/web'
    }
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local'
  }
});
```

Given this layout:

```txt
apps/api/.env
apps/api/.env.local
apps/api/.env.production
apps/web/.env
apps/web/.env.staging
```

Run commands with the resolved environment:

```bash
env-lane run api --build production -- pnpm start
env-lane run web --build staging -- pnpm dev
```

Inspect what will be loaded:

```bash
env-lane files api --build production
env-lane print api --build production --format json
```

## Dotenv Order

The default loading rule is:

```txt
.env
.env.local      when ENV_BUILD=local
.env.<build>    for every other build name
```

Values loaded later override earlier dotenv values. By default, `process.env` is merged after dotenv files, so shell variables win. The selector key is injected into the final environment.

For example:

```bash
ENV_BUILD=production env-lane print api
```

is equivalent to:

```bash
env-lane print api --build production
```

## Workspace Targets

`env-lane` reads package globs from `pnpm-workspace.yaml` when possible. You can also set `workspace.packageGlobs` explicitly.

Targets can be:

- package names, such as `@acme/api`
- relative directories, such as `apps/api`
- aliases from `workspace.aliases`, such as `api`

If no child workspace package exists, the repository root is treated as the only target. If multiple packages exist and no target is supplied, `env-lane` fails with the available names, directories, and aliases unless `workspace.defaultTarget` is configured.

## CLI

### Output Formatting & Prefixing

You can control how `env-lane` formats its output globally across commands using the `--format` option or the `--json` shorthand, and toggle logging prefixes (e.g. `[env-lane]`) using `--no-prefix`.

- `--format text` (Default): Human-readable tables and lists.
- `--format json`: Machine-readable JSON, perfect for piping into `jq`. (Shorthand: `--json`)
- `--format dotenv`: Specific to the `print` command, outputs strict `KEY=VALUE` pairs suitable for shell evaluation or `.env` file generation.
- `--no-prefix`: Suppress logging prefixes such as `[env-lane]` and `[env-lane:vault]`.

**Configuration Equivalent:**

```ts
export default defineConfig({
  output: {
    format: 'text', // 'text' | 'json' | 'dotenv'
    prefix: true // toggle console log prefixes (defaults to true)
  }
})
```

---

List workspace packages:

```bash
env-lane packages
env-lane --json packages
```

Resolve a target:

```bash
env-lane resolve-target api
```

List dotenv files:

```bash
env-lane files api --build production
env-lane --json files all --build staging
env-lane files api --build production --require-override
```

Print the resolved environment:

```bash
env-lane print api --build production
env-lane --json print api --build production
env-lane print api --build production --show-secrets
env-lane print api --build production --include-shell
```

Run a command with injected environment:

```bash
env-lane run api --build production -- pnpm start
env-lane run api --build production --run-cwd root -- pnpm test
env-lane run api --build production --quiet -- node server.js
```

Check dotenv files and configured env policies:

```bash
env-lane check --target api --build production
env-lane check --target api --build production --require-override
env-lane check --policy deploy --build production
env-lane sync webFromW3 --build production
env-lane sync webFromW3 --build production --dry-run
```

Sort env files:

```bash
env-lane sort-file apps/api/.env apps/api/.env.example
env-lane sort env-lane.config.ts api production
env-lane sort env-lane.vault.json api production
```

## Library API

```ts
import {
  checkDotenvSelector,
  listEnvFiles,
  listWorkspacePackages,
  resolveInjectedEnv,
  runEnvCheck,
  runEnvSync,
  runWithInjectedEnv,
  sortEnvFile,
  sortEnvFilesFromConfig
} from '@env-lane/core';

const packages = await listWorkspacePackages();
const files = await listEnvFiles({ target: 'api', build: 'staging' });
const env = await resolveInjectedEnv({ target: 'api', build: 'staging' });

await checkDotenvSelector({ target: 'api', build: 'staging' });
await runEnvCheck('deploy', { build: 'production' });
await runEnvSync('webFromApi', { build: 'production', dryRun: true });
await sortEnvFile('apps/api/.env', 'apps/api/.env.example');
await sortEnvFilesFromConfig('env-lane.config.ts', 'api', 'production');
await runWithInjectedEnv({
  target: 'api',
  build: 'staging',
  command: ['node', 'server.js']
});
```

CommonJS consumers can use the CJS export after the package is built:

```js
const { listEnvFiles, resolveInjectedEnv } = require('@env-lane/core');
```

## Configuration Reference

```ts
import { defineConfig } from '@env-lane/core';

export default defineConfig({
  selector: {
    // Environment selector variable. Defaults to ENV_BUILD.
    envKey: 'ENV_BUILD',
    // Default build name when no CLI/API build is supplied. Defaults to local.
    defaultBuild: 'local',
    // List of valid build names. Used by 'sort' to auto-discover env files
    // and by resolution checks.
    builds: ['staging', 'production'],
    // How to handle a build outside selector.builds. Defaults to warn.
    buildValidation: 'warn',
    // Forbid selector envKey in dotenv files. Defaults to true.
    forbidInDotenv: true
  },
  workspace: {
    // Optional package globs. Defaults to pnpm/npm/yarn workspace patterns.
    packageGlobs: ['apps/*', 'packages/*'],
    // Additional aliases, keyed by alias, value package name or relative directory.
    aliases: {
      api: 'apps/api'
    },
    // Default target when multiple packages exist.
    defaultTarget: 'api',
    // Whether root is exposed as a target. Defaults to true.
    includeRoot: true
  },
  dotenv: {
    // Ordered dotenv patterns relative to target dir. {build} is interpolated.
    order: ['.env', '.env.{build}', '.env.local'],
    // Build name that maps to localOverrideFile. Defaults to local.
    localBuildName: 'local',
    // Override file for local build. Defaults to .env.local.
    localOverrideFile: '.env.local',
    // Merge process.env after dotenv files. Defaults to true.
    includeProcessEnv: true,
    // Preserve UTF-8 BOM when writing environment files. Defaults to true.
    preserveBOM: true,
    // EOL format when writing files. Defaults to auto.
    eol: 'auto' // 'auto' | 'lf' | 'crlf'
  },
  cli: {
    // Custom CLI subcommand/argument aliases
    aliases: {
      dev: 'run api --build local -- pnpm dev'
    }
  },
  sort: {
    // Manual configuration: baseDir is optional if key matches a workspace alias.
    // file and template default to .env and .env.example.
    api: {
      files: {
        // Additional custom files to sort using the same template
        ci: '.env.ci'
      },
      // Create the sorting target files or templates if missing. Defaults to false.
      create: true
    },
    // Explicit path configuration
    legacy: {
      baseDir: 'old-project',
      file: 'configs/.env',
      template: 'configs/.env.template'
    }
  },
  checks: {
    deploy: {
      sources: {
        api: { target: 'api' },
        web: { target: 'web' }
      },
      rules: [
        { type: 'required', source: 'api', key: 'DATABASE_URL' },
        {
          type: 'equals',
          left: { source: 'web', key: 'VITE_API_ORIGIN' },
          right: { source: 'api', key: 'PUBLIC_API_ORIGIN' },
          transform: 'url-base'
        }
      ]
    }
  },
  sync: {
    webFromApi: {
      from: { target: 'api' },
      to: { target: 'web' },
      mappings: [
        { from: 'PUBLIC_API_ORIGIN', to: 'VITE_API_ORIGIN', transform: 'url-base' }
      ]
    }
  },
  vault: {
    enabled: false,
    // Configuration file path relative to root. Defaults to 'env-lane.vault'.
    configFile: 'env-lane.vault',
    disableUnsafeWarning: false
  }
});
```

### Smart Sort Discovery

The `env-lane sort` command employs a "convention over configuration" approach:

1. **Automatic Discovery**: It automatically scans your workspace and identifies all packages. Each package (and its aliases) becomes a valid sort target with default settings (`.env` sorted against `.env.example`).
2. **Flexible Configuration**:
    - If the target key matches a workspace package, `baseDir` defaults to that package's directory.
    - `file` and `template` default to `.env` and `.env.example` if omitted.
    - You can provide a custom `baseDir` to point to any directory.
3. **Build Inference**: If `selector.builds` is defined, `env-lane sort` uses the `dotenv.order` patterns to automatically find and sort build-specific files (e.g., `.env.production`) without manual mapping.

Env-lane and vault config files both support TypeScript, JavaScript ESM, JavaScript CJS, and JSON formats.

### Checks, Sync, and Parsing

`env-lane check --target <target>` runs the built-in dotenv selector check. It verifies that the selector key, such as `ENV_BUILD`, is not committed to dotenv files and can require the selected override file to exist.

`env-lane check --policy <name>` runs a configured env policy from `checks`. Policy checks support required variables, required-any groups, and equality checks with simple transforms such as lowercase normalization or URL-base normalization.

`env-lane sync <name>` copies mapped values from one source to another dotenv file using the same env document writer used by sort and vault restore. It preserves comments, BOMs, and newline style where possible.

Runtime injection and selector checks intentionally use `dotenv.parse()` so they match dotenv loading behavior. Editing commands such as sort, vault restore, and sync use env-lane's structured env document parser/writer so commented entries, duplicate entries, and surrounding comments can be handled consistently.

## Development Vault

`@env-lane/vault` stores reversible encrypted dotenv records for development workflows. It depends on local key-file handling, repository access controls, and CI logging discipline. Do not use it as a production secret-management system.

Prefer CI/CD Secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production secrets.

The vault helpers are optional. Install `@env-lane/vault` alongside `env-lane` before using `env-lane vault ...` commands.

Vault commands print a warning unless warnings are disabled through config or the lower-level API:

```json
{
  "disableUnsafeWarning": true
}
```

By default, the vault configuration is loaded from `env-lane.vault` (or configured via `vault.configFile` in your main config). Example vault config:

```ts
export default {
  envFiles: ['apps/api/.env.local', 'apps/web/.env.local'],
  outputDir: '.env-lane-vault',
  outputFile: 'store.dat',
  trackDeletions: true,
  // Remap absolute paths to workspace-relative paths. Defaults to true.
  autoRemapPaths: true,
  // Allow decrypt/restore of unmanaged files. Defaults to false.
  allowUnmanaged: false,
  // Exclude keys matching patterns from specific files.
  // Supports key-value object mappings or rules array with keys/files aliases:
  exclude: [
    {
      files: ['apps/api/.env.local'],
      keys: ['PUBLIC_*']
    }
  ]
};
```

CLI commands do not require the configuration path argument by default (it is loaded automatically or can be specified with `--vault-config <file>`). They only require the `<keyFile>` argument:

```bash
env-lane vault encrypt key.aes
env-lane vault plan key.aes
env-lane vault decrypt key.aes --dry-run
env-lane vault decrypt key.aes --yes
```

Optional local sync state provides git-like conflict detection without changing the encrypted vault record format. It is disabled unless you explicitly choose a directory, so env-lane will not silently create a system cache of environment data. The sync file stores per-key metadata and value hashes, not plaintext values:

```bash
env-lane vault encrypt key.aes --sync-dir .env-lane-sync
env-lane vault plan key.aes --sync-dir .env-lane-sync
env-lane vault decrypt key.aes --sync-dir .env-lane-sync --conflicts ask
```

When both the local dotenv value and the latest vault record changed since the last sync baseline, env-lane reports a conflict. Use `--conflicts ask`, `--conflicts overwrite`, or `--conflicts ignore` on `vault encrypt` and `vault decrypt` to decide per item or apply a consistent policy. If no sync baseline exists yet, env-lane falls back to the dotenv file mtime when it can.

Vault history can be compacted by age or by keeping only the latest records for each file/key pair. The latest record is preserved by default so the current restore result remains available:

```bash
env-lane vault prune key.aes --keep-recent 3 --dry-run
env-lane vault prune key.aes --older-than-days 30 --yes
env-lane vault prune key.aes --file apps/api/.env.local --key API_TOKEN --keep-recent 2 --yes
```

## Local Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Useful release checks:

```bash
pnpm check
pnpm pack:dry-run
pnpm publish:dry-run
```

## Publishing

The workspace is prepared for npm publishing with public access and provenance.

1. Update package versions and `CHANGELOG.md`.
2. Run `pnpm check`.
3. Run `pnpm build`.
4. Run `pnpm pack:dry-run` and inspect the package contents.
5. Publish with `pnpm release`, or use the included GitHub Actions release workflow.

The publishable packages are:

```txt
packages/core   -> @env-lane/core
packages/vault  -> @env-lane/vault
packages/cli    -> env-lane
```

For GitHub Actions trusted publishing, configure the npm package publishing settings for this repository and workflow, then run the release workflow from GitHub.

## License

MIT
