# @env-lane/core

Core APIs for `env-lane`: config loading, pnpm workspace discovery, dotenv resolution, policies,
redaction, command execution, shared env-document editing, and env-file sorting.

```bash
pnpm add -D @env-lane/core
```

```ts
import {
  listEnvFiles,
  resolveInjectedEnv,
  runEnvCheck,
  runEnvSync,
  sortEnvFilesFromConfig
} from '@env-lane/core';

const files = await listEnvFiles({ target: 'api', build: 'production' });
const env = await resolveInjectedEnv({ target: 'api', build: 'production' });
await runEnvCheck('deploy', { build: 'production' });
await runEnvSync('webFromApi', { build: 'production', dryRun: true });
await sortEnvFilesFromConfig('env-lane.config.ts', 'api', 'production');
const check = await sortEnvFilesFromConfig('env-lane.config.ts', 'api', 'production', {
  check: true
});
```

Sorting APIs accept `cwd` in their options. Relative config, env-file, and template paths resolve
from that directory, or from `process.cwd()` when it is omitted. Relative paths declared inside a
sort config resolve from the discovered project root and the target `baseDir`.
Set `check: true` (CLI: `--check`) to report `changed` without writing; the CLI exits with status 1
when drift is found.

Public use cases normalize `cwd` once for config discovery and caller-relative paths. In
`runWithInjectedEnv`, `runCwd` independently selects `target`, `root`, or a child directory relative
to `cwd`; it does not replace the invocation context.

Runtime and editing APIs use the same line-level env AST. Assignment nodes preserve concrete syntax while exposing a `dotenv`-compatible `effectiveValue`, keeping injection, checks, sync, sort, and vault behavior aligned.

Redaction combines secret-like key names with value inspection. The public `isJwt`, `isPaseto`,
and `isHighEntropyString` classifiers are provider-neutral; high-entropy detection can be tuned with
`minEntropyLength`, `entropyThreshold`, and `minCharacterClasses`. `minRedactionLength` defaults to
8, so shorter values are always preserved. Known public identifiers such as public-key PEM values,
Ethereum addresses, Supabase publishable keys, and comma-separated human identifier lists are
excluded from the heuristic.

The stable package root contains configuration and high-level use cases. Deployment scripts may
also access this curated root through the `env-lane` convenience facade. Import the lower-level
dotenv document feature through its owning package:

```ts
import {
  applyEnvDocumentPatches,
  parseEnvDocument,
  parseEnvLine,
} from '@env-lane/core/env-document';
```

The same document symbols remain at the Core root in 0.4.x as deprecated compatibility exports.
They are planned for removal in the next intentionally breaking release. Config adapter internals,
resolved-input helpers, the Node file adapter, sort planner internals, and workspace orchestration
internals exported from the root are deprecated on the same schedule.

Core and Vault APIs are silent unless called inside an explicit async context. Diagnostics are emitted through the context logger and are not mixed into operation results:

```ts
import { withEnvLaneContext } from '@env-lane/core';

await withEnvLaneContext(
  { logger: { diagnostic: event => process.stderr.write(`${JSON.stringify(event)}\n`) } },
  () => resolveInjectedEnv({ target: 'api' })
);
```

Documentation:

- [Configuration](https://github.com/billstark001/env-lane/blob/main/docs/config.md)
- [API and compatibility](https://github.com/billstark001/env-lane/blob/main/docs/api.md)
- [Architecture](https://github.com/billstark001/env-lane/blob/main/docs/architecture.md)
