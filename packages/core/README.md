# @env-lane/core

Stable application calls use the Rust Node-API binding from
`@env-lane/native`. Configuration evaluation, diagnostic context, public TypeScript types,
and the env-document feature facade remain in JavaScript. Document
parsing, formatting, and patch planning now run in Rust; the facade preserves the public `Map`
shapes and file write behavior. See
[native migration](../../docs/native-migration.md).

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

The numeric API passes through normal child exit codes, maps startup failures to 126/127, and
returns 128 plus the signal number for POSIX signal termination. Use `runWithInjectedEnvDetailed`
for `{ exitCode, signal, spawnError? }`, or `spawnWithInjectedEnv({ ..., stdio: 'pipe' })` for
direct access to the child streams and a completion promise. By default all three child streams
are inherited.

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

The deprecated Core root document and internal adapter exports from 0.4.x were removed in 0.5.0.
Import the document feature from `@env-lane/core/env-document`.

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
