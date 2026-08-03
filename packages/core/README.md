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

The stable package root contains configuration and high-level use cases. Import the lower-level
dotenv document feature through its dedicated entry point:

```ts
import {
  applyEnvDocumentPatches,
  parseEnvDocument,
  parseEnvLine,
} from '@env-lane/core/env-document';
```

The same document symbols remain available from the package root during the compatibility period,
but new code should use the feature entry point so internal Core restructuring does not affect it.

Core and Vault APIs are silent unless called inside an explicit async context. Diagnostics are emitted through the context logger and are not mixed into operation results:

```ts
import { withEnvLaneContext } from '@env-lane/core';

await withEnvLaneContext(
  { logger: { diagnostic: event => process.stderr.write(`${JSON.stringify(event)}\n`) } },
  () => resolveInjectedEnv({ target: 'api' })
);
```

See the full documentation at https://github.com/billstark001/env-lane#readme.
