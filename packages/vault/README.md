# @env-lane/vault

Development-only reversible encrypted dotenv record storage for `env-lane`.

~~~bash
pnpm add -D @env-lane/vault
~~~

This package is intentionally unsafe for production secret management. Encryption does not make a
Vault store or key file safe to publish and cannot prevent Git, backups, cloud-sync clients, logs,
or other tools from copying local files. Prefer a platform Secret Manager, KMS, SOPS, age, or
HashiCorp Vault for production secrets.

## Library

~~~ts
import {
  applyRestorePlan,
  buildRestorePlan,
  encryptEnvFiles,
  loadVaultConfig,
  pruneVaultHistory,
  sanitizeVaultHistory
} from '@env-lane/vault';

await encryptEnvFiles(undefined, 'key.aes', {
  vaultConfigFile: 'env-lane.vault.ts',
  dryRun: true
});

const plan = await buildRestorePlan(undefined, 'key.aes', {
  vaultConfigFile: 'env-lane.vault.ts'
});

await applyRestorePlan(undefined, 'key.aes', plan, {
  autoApprove: true,
  decisions: plan.files.flatMap(file =>
    file.entries
      .filter(entry => entry.action !== 'identical')
      .map(entry => ({
        entryId: entry.entryId,
        decision: entry.action === 'delete' ? 'skip' : 'apply-vault'
      }))
  )
});

await pruneVaultHistory(undefined, 'key.aes', {
  keepRecent: 3,
  dryRun: true
});
await sanitizeVaultHistory(undefined, 'key.aes', {
  excluded: true,
  dryRun: true
});
await loadVaultConfig(undefined, {
  vaultConfigFile: 'env-lane.vault.ts'
});
~~~

Plans contain redacted previews and are bound to current store and dotenv state. Deletes are skipped
unless explicitly approved. Core and Vault library APIs never access terminal streams; diagnostics
require an explicit Core context, and conflict decisions come from options or callbacks.

## CLI

Install `env-lane` alongside this package:

~~~bash
env-lane vault encrypt key.aes
env-lane vault encrypt key.aes --dry-run --json
env-lane vault plan key.aes --output restore-plan.json --json
env-lane vault apply key.aes --plan restore-plan.json --yes --non-interactive
env-lane vault prune key.aes --keep-recent 3 --dry-run
~~~

The CLI loads its adapter from `@env-lane/vault/cli`.

~~~ts
import { registerVaultCommands } from '@env-lane/vault/cli';
~~~

The Vault-root `registerVaultCommands` export is deprecated in 0.4.0 and is planned for removal in
the next intentionally breaking release. Vault-root cryptographic helpers are implementation
details deprecated on the same schedule.

## Safety model

- Schema v1 records store dotenv effective values and portable config-relative file paths;
  versionless/v0 records remain readable.
- `exclude` is a fail-closed local-only boundary; sanitize old matching history before continuing.
- Optional `syncDir` uses keyed fingerprints for three-way conflict detection.
- Restore plans bind digest, complete entry set, and explicit decisions before apply.
- Operations on the same store are serialized and individual files use atomic replacement.
- Multi-file writes are not a crash-atomic database transaction; rerun plan after interruption.

Full documentation:

- [Vault workflows and configuration](https://github.com/billstark001/env-lane/blob/main/docs/vault.md)
- [API and compatibility](https://github.com/billstark001/env-lane/blob/main/docs/api.md)
