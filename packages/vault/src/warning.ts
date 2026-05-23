import { getLogger } from '@env-lane/core'

export const VAULT_UNSAFE_WARNING = `[env-lane:vault] WARNING: This vault is not a production secret-management system.
[env-lane:vault] It stores reversible encrypted .env records and depends on local key-file handling.
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
