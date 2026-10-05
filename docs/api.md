# API and compatibility

## 0.5.0 runtime

Stable Core and Vault application calls now use `@env-lane/native` through thin ESM/CommonJS
facades. The binding accepts JSON requests, returns value and diagnostic envelopes, and maps Rust
error codes to `EnvLaneError`. The facades retain JS/TS source evaluation, diagnostic context,
public types, and callback orchestration. `@env-lane/vault/cli` is the standalone Commander adapter.

Vault restore callbacks resolve decisions in JavaScript, then send explicit decisions to the Rust
apply operation. Vault encrypt callbacks receive native candidates and a frozen dotenv snapshot;
JavaScript collects their decisions under the operation lock, and Rust applies them. See
[native migration status](native-migration.md).

The stable entries below remain supported in 0.5.0.

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

The native `env-lane vault` command is provided by the plugin package metadata. The Commander
adapter above is available only to programs that embed it; the native CLI does not load it.

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

## Migration from 0.4.2

| Removed in 0.5.0 | Use instead |
| --- | --- |
| Core root env-document exports, including transitively through `env-lane` | `@env-lane/core/env-document` |
| Core root config discovery helpers | `loadEnvLaneConfig` or application-owned discovery |
| `listEnvFilesForTarget`, `resolveBuildName` | `listEnvFiles` with public options |
| `writeFileContentAtomically` | Application-owned persistence |
| `buildEnvSortPlan`, `EnvSortPlan`, `SortOperationAction` | `sortEnvFile` or `sortEnvFilesFromConfig` |
| `listWorkspacePackagesForConfig`, `resolveTargetPackageFromList` | `listWorkspacePackages`, `resolveTargetPackage` |
| Vault root `registerVaultCommands`, `VaultCliContext` | `@env-lane/vault/cli` |
| Vault root crypto helpers | The Vault automation APIs; the crypto implementation is not a public key-management API |
| `env-files`, `env-json` CLI aliases | `files`, `print` |
| `plugins: []` manifest registration | Named root plugin fields with `enabled`, `configFile`, and `packageName` |
| Vault exclude object/shorthand fields | `exclude: [{ files: [...], keys: [...] }]` |

The first argument to `loadVaultConfig(configPath?, options?)` now always names a Vault config file. `options.vaultConfigFile` names it when the first argument is absent; passing both is an error. `vault.enabled` must be `true` for Vault commands and Node API calls. Vault can omit `packageName` because the built-in table supplies `@env-lane/vault`. Other plugin fields require it.

The Vault record store and sync-state formats are separate persisted-data contracts. v0/v1 record reads and legacy sync-state migration remain supported.

## Plugin author API

Rust authors use `env-lane-plugin-api`; Node authors use `@env-lane/plugin-sdk`. Both use the same protocol version 1 and package `envLanePlugin` metadata. See [plugin packages and protocol](native-plugin-protocol.md).

## Published contract verification

The build check imports every stable entry in ESM and CommonJS, verifies declarations and removed root exports, and exercises the native npm bin. Synthetic conformance covers a Rust Vault plugin and a JS plugin command/namespace. The frozen 0.4.2 oracle continues to guard stable Core and persisted Vault data behavior.
