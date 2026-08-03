# @env-lane/vault

Development-only reversible encrypted dotenv record storage for `env-lane`.

```bash
pnpm add -D @env-lane/vault
```

This package is intentionally unsafe for production secret management. Prefer CI/CD Secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production secrets.

Vault schema version 1 records store dotenv effective values. Records without a version, or with version 0, are treated as the earlier raw-value format and converted through the shared dotenv AST when loaded. New records always use version 1.

```ts
import {
  buildRestorePlan,
  decryptEnvFiles,
  encryptEnvFiles,
  loadVaultConfig,
  pruneVaultHistory,
} from '@env-lane/vault';

await encryptEnvFiles('env-lane.vault.json', 'key.aes');
await buildRestorePlan('env-lane.vault.json', 'key.aes');
await decryptEnvFiles('env-lane.vault.json', 'key.aes', { dryRun: true });
await pruneVaultHistory('env-lane.vault.json', 'key.aes', { keepRecent: 3, dryRun: true });
await loadVaultConfig('env-lane.vault.ts');
```

Vault config files can be TypeScript, JavaScript ESM, JavaScript CJS, or JSON.

## Optional sync state

Vault sync conflict detection does not change the encrypted vault record format. When enabled, env-lane writes a local `vault-sync-state.json` file in a directory that you explicitly pass with `syncDir` or `--sync-dir`. The file stores per-key metadata and value hashes, not environment variable values.

```bash
env-lane vault encrypt env-lane.vault.json key.aes --sync-dir .env-lane-sync
env-lane vault plan env-lane.vault.json key.aes --sync-dir .env-lane-sync
env-lane vault decrypt env-lane.vault.json key.aes --sync-dir .env-lane-sync --conflicts ask
```

If a local key and the latest vault record both changed since the last sync baseline, the command reports a conflict. Use `--conflicts ask`, `--conflicts overwrite`, or `--conflicts ignore` to choose whether the vault value overwrites the local dotenv file, or the local dotenv value overwrites the vault history during encrypt.

## History pruning

Vault history can be compacted without changing the record format:

```bash
env-lane vault prune env-lane.vault.json key.aes --keep-recent 3 --dry-run
env-lane vault prune env-lane.vault.json key.aes --older-than-days 30 --yes
env-lane vault prune env-lane.vault.json key.aes --file apps/api/.env.local --key API_TOKEN --keep-recent 2 --yes
```

By default, pruning keeps the latest record for every file/key pair so the current restore result remains available.

See the full documentation at https://github.com/billstark001/env-lane#readme.
