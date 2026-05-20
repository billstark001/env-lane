# env-lane

`env-lane` is a TypeScript + ESM + pnpm workspace skeleton for workspace-aware dotenv injection. It was designed to replace project-specific scripts with reusable packages:

- `@env-lane/core`: config loading, pnpm workspace package discovery, target resolution, dotenv injection order, final env resolution, selector checks, and command execution.
- `@env-lane/vault`: development-only reversible encrypted `.env` record storage plus env-file sorting helpers.
- `env-lane`: CLI package that exposes the `env-lane` binary and re-exports the library APIs.

The workspace intentionally avoids project-specific strings. The default build selector is `ENV_BUILD`, configurable through `env-lane.config.ts`.

## Install as dev dependencies

```bash
pnpm add -D env-lane @env-lane/core @env-lane/vault
```

For local development of this repo:

```bash
pnpm install
pnpm test
pnpm build
```

## Configuration

Create `env-lane.config.ts` in the repository root:

```ts
import { defineConfig } from '@env-lane/core';

export default defineConfig({
  selector: {
    envKey: 'ENV_BUILD',
    defaultBuild: 'local',
    forbidInDotenv: true
  },
  workspace: {
    packageGlobs: ['apps/*', 'packages/*'],
    aliases: {
      api: '@acme/api',
      web: '@acme/web'
    },
    includeRoot: true
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local'
  },
  vault: {
    enabled: false,
    disableUnsafeWarning: false
  }
});
```

If no child workspace package exists, `env-lane` treats the repository root as the only target. If child packages exist and no target is supplied, it fails and lists available names, directories, and aliases unless `workspace.defaultTarget` is configured.

## CLI

```bash
env-lane packages --format json
env-lane files api --build production --format json
env-lane print api --build production --format dotenv
env-lane print api --build production --format json
env-lane run api --build production -- pnpm start
env-lane check
```

The dotenv loading rule defaults to:

```txt
.env
.env.local          when ENV_BUILD=local
.env.<build>        for every other build name
```

Shell variables override dotenv values by default, and the selector variable is injected into the final environment.

## Library API

ESM:

```ts
import { listEnvFiles, resolveInjectedEnv } from '@env-lane/core';

const files = await listEnvFiles({ target: 'api', build: 'staging' });
const resolved = await resolveInjectedEnv({ target: 'api', build: 'staging' });
```

CommonJS after build:

```js
const { listEnvFiles, resolveInjectedEnv } = require('@env-lane/core');

async function main() {
  const files = await listEnvFiles({ target: 'api', build: 'staging' });
  const resolved = await resolveInjectedEnv({ target: 'api', build: 'staging' });
}
```

Useful CI/CD calls:

```ts
await listEnvFiles({ target: 'api', build: 'production' });
await resolveInjectedEnv({ target: 'api', build: 'production', includeProcessEnv: true });
```

## Vault warning

`@env-lane/vault` is intentionally marked as unsafe for production secret management. It stores reversible encrypted `.env` records and depends on local key-file handling, repository access controls, and CI logging discipline.

Every vault encrypt/decrypt command prints a warning unless disabled explicitly in config or via the lower-level API option:

```json
{
  "disableUnsafeWarning": true
}
```

Do not use this as a production secret-management system. Prefer CI/CD Secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager.

CLI examples:

```bash
env-lane vault encrypt env-lane.vault.json key.aes
env-lane vault decrypt env-lane.vault.json key.aes
env-lane sort-file apps/api/.env apps/api/.env.example
env-lane sort env-lane.vault.json api production
```

## Package layout

```txt
packages/core   # @env-lane/core
packages/vault  # @env-lane/vault
packages/cli    # env-lane CLI package
```

## Notes

This is a functional scaffold, not a final audited release. Before publishing, run a full dependency install, `pnpm test`, `pnpm typecheck`, and `pnpm build`, then extend the compatibility tests around edge cases from your existing scripts.
