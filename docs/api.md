# API and compatibility

Version 0.4.0 establishes explicit package boundaries before a later intentionally breaking cleanup.
New code should depend only on the stable entries below.

## Stable entry points

### `env-lane`

The executable package intentionally re-exports the curated `@env-lane/core` root API. This is a
stable convenience facade for configuration files and deployment scripts; it is not scheduled for
removal in the next intentionally breaking release.

~~~ts
import { defineConfig, resolveInjectedEnv, runEnvCheck } from 'env-lane';
~~~

Feature subpaths are not re-exported by the facade. Import them from their owning package.

### `@env-lane/core`

The stable root contains:

- Configuration: `defineConfig`, `loadEnvLaneConfig`.
- Resolution: `listEnvFiles`, `resolveInjectedEnv`.
- Workspace use cases: `listWorkspacePackages`, `resolveTargetPackage`.
- Checks and sync: `checkDotenvSelector`, `defineEnvCheck`, `defineEnvSync`,
  `runEnvCheck`, `runEnvSync`.
- Execution and sorting: `runWithInjectedEnv`, `sortEnvFile`,
  `sortEnvFilesFromConfig`.
- Diagnostics and errors: `EnvLaneError`, `errorCode`, `withEnvLaneContext`, and the
  diagnostic formatting API.
- Redaction and public configuration/result types, including provider-neutral `isJwt`, `isPaseto`,
  configurable `isHighEntropyString` classifiers, and the eight-character default
  `minRedactionLength` floor.

Sorting options accept `check: true` to calculate and return drift without writing files. Per-file
and aggregate results expose `changed`; `applied` remains false in check mode. `runWithInjectedEnv`
uses `cwd` for invocation/config resolution and the distinct `runCwd` option for the child working
directory.

The lower-level document feature has a stable dedicated entry:

~~~ts
import {
  applyEnvDocumentPatches,
  parseEnvDocument,
  setEnvDocumentValues
} from '@env-lane/core/env-document';
~~~

### `@env-lane/vault`

The stable root contains Vault configuration and automation use cases:

- `defineVaultConfig`, `loadVaultConfig`.
- `encryptEnvFiles`, `buildRestorePlan`, `decryptEnvFiles`, `applyRestorePlan`.
- Approval document and selection helpers.
- `pruneVaultHistory`, `sanitizeVaultHistory`.
- Restore, conflict, record, selection, and result types.
- `VAULT_UNSAFE_WARNING` and explicit `warnUnsafeVault()`.

Vault restore configuration exposes `VaultRestoreRedaction` (`full`, `partial`, or `none`) and
`VaultRestoreReveal` (leading/trailing hint lengths). Restore APIs accept one-off
`restoreRedaction` and `restoreReveal` options; otherwise they use the Vault config. Full redaction
without revealed characters remains the default, subject to the eight-character floor.

`encryptEnvFiles` accepts `dryRun: true` for a no-write preview of selected records and changes.
The result exposes `dryRun`, `applied`, record counts, conflicts, and the selected `changes`; no
store, sync state, output directory, or write lock is created by the preview.

The optional Commander adapter has a stable dedicated entry:

~~~ts
import { registerVaultCommands } from '@env-lane/vault/cli';
~~~

Library APIs are terminal-independent. Put diagnostics behind an explicit async context:

~~~ts
import { resolveInjectedEnv, withEnvLaneContext } from '@env-lane/core';

await withEnvLaneContext(
  {
    logger: {
      diagnostic: event =>
        process.stderr.write(`${JSON.stringify(event)}\n`)
    }
  },
  () => resolveInjectedEnv({ target: 'api' })
);
~~~

## Deprecated in 0.4.0

These exports remain available in 0.4.x only to give existing consumers a migration window.
TypeScript declaration output includes `@deprecated` documentation.

| Current compatibility export | Migration |
| --- | --- |
| Core root env-document types/functions, including transitively through `env-lane` | Import from `@env-lane/core/env-document`. |
| `findWorkspaceRoot`, `loadConfigWithC12`, `readPnpmWorkspaceGlobs`, `LoadConfigOptionsWithC12` | Use `loadEnvLaneConfig` or own application-specific discovery; these are config adapter internals. |
| `listEnvFilesForTarget`, `resolveBuildName` | Use `listEnvFiles` and pass the target/build through public options. |
| `writeFileContentAtomically` | Keep file persistence in the consuming application; this is a Node adapter detail. |
| `buildEnvSortPlan`, `EnvSortPlan`, `SortOperationAction` | Use `sortEnvFile` or `sortEnvFilesFromConfig`. |
| `listWorkspacePackagesForConfig`, `resolveTargetPackageFromList` | Use `listWorkspacePackages` and `resolveTargetPackage`. |
| Vault-root `registerVaultCommands` and `VaultCliContext` | Import from `@env-lane/vault/cli`. |
| Vault-root crypto helpers | Do not depend on the encrypted record implementation as a key-management API. |

Vault crypto helpers currently include `encryptRecord`, `decryptRecord`, `deriveVaultKey`,
`deriveVaultSyncKey`, `keyedDigest`, and `stableHash`.

## Planned breaking cleanup

The following cleanup belongs to a future intentionally breaking release, not 0.4.x. Its
compatibility work is limited and explicit:

1. Remove the deprecated Core root exports listed above.
2. Remove Vault-root CLI and crypto compatibility exports.
3. Remove the CLI fallback that loads `registerVaultCommands` from the old Vault root.
4. Drop `@env-lane/vault` 0.3 from the optional peer range once the fallback is removed.

Before that release, search consumer code for:

~~~bash
rg "from ['\"](@env-lane/core|@env-lane/vault)['\"]"
~~~

Then compare imported symbols with the table above. Imports from the `env-lane` convenience
facade using the stable Core root API do not need to move.

This cleanup does not imply a Vault record-format migration. Schema v1 uses portable
Vault-config-relative paths; schema v0 record reads, absolute-path remapping, and legacy unkeyed
sync-state rebasing are persisted-data compatibility paths and are not deprecated by the 0.4.0 API
boundary work. Any future removal of persisted formats requires a separate migration plan and
release note.

## Published contract verification

The release check builds and imports every stable entry in ESM and CommonJS, verifies declaration
files, checks that feature entries do not leak unrelated APIs, and exercises the built CLI in child
processes. Add new public entries to that contract test before publishing them.
