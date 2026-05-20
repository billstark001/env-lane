export const VAULT_UNSAFE_WARNING = `[env-lane:vault] WARNING: This vault is not a production secret-management system.\n[env-lane:vault] It stores reversible encrypted .env records and depends on local key-file handling.\n[env-lane:vault] Use CI/CD secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production.`

export function warnUnsafeVault(
  options: { disableUnsafeWarning?: boolean; stderr?: Pick<typeof process.stderr, 'write'> } = {},
): void {
  if (options.disableUnsafeWarning) return
  ;(options.stderr ?? process.stderr).write(`${VAULT_UNSAFE_WARNING}\n`)
}
