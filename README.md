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

`env-lane` requires Node.js 20 or newer.

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

List workspace packages:

```bash
env-lane packages
env-lane packages --format json
```

Resolve a target:

```bash
env-lane resolve-target api
```

List dotenv files:

```bash
env-lane files api --build production
env-lane files all --build staging --format json
env-lane files api --build production --require-override
```

Print the resolved environment:

```bash
env-lane print api --build production
env-lane print api --build production --format json
env-lane print api --build production --show-secrets
env-lane print api --build production --include-shell
```

Run a command with injected environment:

```bash
env-lane run api --build production -- pnpm start
env-lane run api --build production --run-cwd root -- pnpm test
env-lane run api --build production --quiet -- node server.js
```

Check dotenv files:

```bash
env-lane check
env-lane check api --build production
env-lane check api --build production --require-override
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
  runWithInjectedEnv,
  sortEnvFile,
  sortEnvFilesFromConfig
} from '@env-lane/core';

const packages = await listWorkspacePackages();
const files = await listEnvFiles({ target: 'api', build: 'staging' });
const env = await resolveInjectedEnv({ target: 'api', build: 'staging' });

await checkDotenvSelector({ target: 'api', build: 'staging' });
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
    // List of valid build names. Used by 'sort' to auto-discover env files.
    builds: ['staging', 'production'],
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
    includeProcessEnv: true
  },
  sort: {
    // Manual configuration: baseDir is optional if key matches a workspace alias.
    // file and template default to .env and .env.example.
    api: {
      files: {
        // Additional custom files to sort using the same template
        ci: '.env.ci'
      }
    },
    // Explicit path configuration
    legacy: {
      baseDir: 'old-project',
      file: 'configs/.env',
      template: 'configs/.env.template'
    }
  },
  vault: {
    enabled: false,
    configFile: 'env-lane.vault.json',
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

Example vault config:

```ts
export default {
  envFiles: ['apps/api/.env.local', 'apps/web/.env.local'],
  outputDir: '.env-lane-vault',
  outputFile: 'store.dat',
  trackDeletions: true,
  exclude: {
    'apps/api/.env.local': ['PUBLIC_*']
  }
};
```

CLI:

```bash
env-lane vault encrypt env-lane.vault.json key.aes
env-lane vault plan env-lane.vault.json key.aes
env-lane vault decrypt env-lane.vault.json key.aes --dry-run
env-lane vault decrypt env-lane.vault.json key.aes --yes
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
