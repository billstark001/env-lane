# @env-lane/vault

Development-only reversible encrypted dotenv record storage for `env-lane`.

```bash
pnpm add -D @env-lane/vault
```

This package is intentionally unsafe for production secret management. Prefer CI/CD Secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production secrets.

```ts
import { buildRestorePlan, decryptEnvFiles, encryptEnvFiles, loadVaultConfig } from '@env-lane/vault';

await encryptEnvFiles('env-lane.vault.json', 'key.aes');
await buildRestorePlan('env-lane.vault.json', 'key.aes');
await decryptEnvFiles('env-lane.vault.json', 'key.aes', { dryRun: true });
await loadVaultConfig('env-lane.vault.ts');
```

Vault config files can be TypeScript, JavaScript ESM, JavaScript CJS, or JSON.

See the full documentation at https://github.com/billstark001/env-lane#readme.
