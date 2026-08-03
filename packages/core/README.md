# @env-lane/core

Core APIs for `env-lane`: config loading, pnpm workspace package discovery, target resolution, dotenv injection order, final environment resolution, selector checks, env policy checks, env sync, command execution, redaction, shared env document editing, and env-file sorting.

```bash
pnpm add -D @env-lane/core
```

```ts
import { listEnvFiles, resolveInjectedEnv, runEnvCheck, runEnvSync, sortEnvFilesFromConfig } from '@env-lane/core';

const files = await listEnvFiles({ target: 'api', build: 'production' });
const env = await resolveInjectedEnv({ target: 'api', build: 'production' });
await runEnvCheck('deploy', { build: 'production' });
await runEnvSync('webFromApi', { build: 'production', dryRun: true });
await sortEnvFilesFromConfig('env-lane.config.ts', 'api', 'production');
```

Runtime and editing APIs use the same line-level env AST. Assignment nodes preserve concrete syntax while exposing a `dotenv`-compatible `effectiveValue`, keeping injection, checks, sync, sort, and vault behavior aligned.

See the full documentation at https://github.com/billstark001/env-lane#readme.
