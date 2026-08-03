import { emitDiagnostic } from '@env-lane/core'

export const VAULT_UNSAFE_WARNING = `This vault is not a production secret-management system.
Its records are reversible; encryption does not make the store or key file safe to publish.
env-lane cannot prevent Git, cloud-sync, backup, logs, or other tools from uploading local files.
Configured exclude rules keep matching values out of this vault only; sanitize existing history after adding a rule.
Use CI/CD secrets, cloud KMS, HashiCorp Vault, SOPS, age, or a platform Secret Manager for production.`

export function warnUnsafeVault(options: { disableUnsafeWarning?: boolean } = {}): void {
  if (options.disableUnsafeWarning) return
  emitDiagnostic({
    code: 'VAULT_UNSAFE_FOR_PRODUCTION',
    level: 'warning',
    scope: 'vault',
    message: VAULT_UNSAFE_WARNING,
  })
}
