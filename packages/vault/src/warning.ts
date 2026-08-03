import { getLogger } from '@env-lane/core'

export const VAULT_UNSAFE_WARNING = `[env-lane:vault] WARNING: This vault is not a production secret-management system.
[env-lane:vault] Its records are reversible; encryption does not make the store or key file safe to publish.
[env-lane:vault] env-lane cannot prevent Git, cloud-sync, backup, logs, or other tools from uploading local files.
[env-lane:vault] Configured exclude rules keep matching values out of this vault only; sanitize existing history after adding a rule.
[env-lane:vault] Use CI/CD secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production.`

export function warnUnsafeVault(
  options: { disableUnsafeWarning?: boolean; stderr?: Pick<typeof process.stderr, 'write'> } = {},
): void {
  if (options.disableUnsafeWarning) return
  if (options.stderr) {
    options.stderr.write(`${VAULT_UNSAFE_WARNING}\n`)
  } else {
    getLogger().warn(VAULT_UNSAFE_WARNING)
  }
}
