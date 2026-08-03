# @env-lane/vault

Development-only reversible encrypted dotenv record storage for `env-lane`.

```bash
pnpm add -D @env-lane/vault
```

This package is intentionally unsafe for production secret management. Prefer CI/CD Secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production secrets.

Encryption does not make the Vault store or key file safe to publish. Env-lane cannot prevent Git, cloud-sync clients, backups, logs, or other tools from uploading local files.

Vault schema version 1 records store dotenv effective values. Records without a version, or with version 0, are treated as the earlier raw-value format and converted through the shared dotenv AST when loaded. New records always use version 1.

```ts
import {
  buildRestorePlan,
  decryptEnvFiles,
  encryptEnvFiles,
  loadVaultConfig,
  pruneVaultHistory,
  sanitizeVaultHistory,
} from '@env-lane/vault';

await encryptEnvFiles('env-lane.vault.json', 'key.aes');
await buildRestorePlan('env-lane.vault.json', 'key.aes');
await decryptEnvFiles('env-lane.vault.json', 'key.aes', { dryRun: true });
await pruneVaultHistory('env-lane.vault.json', 'key.aes', { keepRecent: 3, dryRun: true });
await sanitizeVaultHistory('env-lane.vault.json', 'key.aes', { excluded: true, dryRun: true });
await loadVaultConfig('env-lane.vault.ts');
```

Vault config files can be TypeScript, JavaScript ESM, JavaScript CJS, or JSON.

## Local-only exclude rules

`exclude` means that matching values are local-only: Vault never persists, restores, syncs, deletes, or previews them. This is only an env-lane Vault boundary and cannot prevent Git or other software from uploading the original dotenv files.

If matching records already exist in Vault history, normal commands fail closed. Inspect and atomically remove all of them before continuing:

```bash
env-lane vault sanitize key.aes --vault-config env-lane.vault.json --excluded --dry-run
env-lane vault sanitize key.aes --vault-config env-lane.vault.json --excluded --yes
```

Rotate previously stored secrets because sanitizing local Vault history cannot remove copies held elsewhere.

## Optional sync state

Vault sync conflict detection does not change the encrypted Vault record format. Passing `syncDir` or `--sync-dir` explicitly consents to creation of additional local state in that directory; it is never created implicitly. `vault-sync-state.json` contains variable names, relative paths, timestamps, and HMAC-SHA256 value fingerprints keyed with a key derived from the Vault key. It does not copy dotenv files or contain plaintext values, and excluded variables are omitted.

```bash
env-lane vault encrypt key.aes --vault-config env-lane.vault.json --sync-dir .env-lane-sync
env-lane vault plan key.aes --vault-config env-lane.vault.json --sync-dir .env-lane-sync
env-lane vault decrypt key.aes --vault-config env-lane.vault.json --sync-dir .env-lane-sync --conflicts ask
```

Sync state schema v1 uses keyed fingerprints. Existing unkeyed sync state is treated as version 0 and safely rebased. A differing first sync is an unbased conflict; file mtimes are never used to guess a winner.

Use `--conflicts abort` (the default), `keep-local`, `take-vault`, or the explicitly interactive `ask`. The preferred source has the same name in every command.

Without `--sync-dir`, schema v1 has no causal baseline: encrypt uses local values as its source and decrypt uses Vault as its source, but reliable conflict detection is intentionally unsupported. Store, sync-state, and dotenv writes use atomic replacement.

## History pruning

Vault history can be compacted without changing the record format:

```bash
env-lane vault prune key.aes --vault-config env-lane.vault.json --keep-recent 3 --dry-run
env-lane vault prune key.aes --vault-config env-lane.vault.json --older-than-days 30 --yes
env-lane vault prune key.aes --vault-config env-lane.vault.json --file apps/api/.env.local --key API_TOKEN --keep-recent 2 --yes
```

By default, pruning keeps the latest record for every file/key pair so the current restore result remains available.

See the full documentation at https://github.com/billstark001/env-lane#readme.
