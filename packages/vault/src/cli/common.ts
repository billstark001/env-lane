import { emitDiagnostic } from '@env-lane/core'
import { loadVaultConfig, type VaultConfig } from '../config.js'
import { parseVaultFailCondition, restorePlanMatchesFailCondition } from '../restore.js'
import type { RestorePlan } from '../types.js'
import { warnUnsafeVault } from '../warning.js'
import type { VaultCommandOptions } from './types.js'

export async function emitUnsafeWarning(allOpts: VaultCommandOptions): Promise<VaultConfig> {
  const config = await loadVaultConfig(allOpts.config, {
    cwd: allOpts.cwd,
    vaultConfigFile: allOpts.vaultConfig,
    autoRemapPaths: allOpts.autoRemap,
    allowUnmanaged: allOpts.allowUnmanaged,
  })
  warnUnsafeVault({ disableUnsafeWarning: config.disableUnsafeWarning })
  return config
}

export function emitPlanDiagnostics(plan: RestorePlan): void {
  if (plan.failedRecords > 0) {
    emitDiagnostic({
      code: 'VAULT_UNREADABLE_RECORDS_SKIPPED',
      level: 'warning',
      scope: 'vault',
      message: `Skipped ${plan.failedRecords} unreadable store record(s).`,
    })
  }
  if (plan.aliasedRecords > 0) {
    emitDiagnostic({
      code: 'VAULT_PATHS_REMAPPED',
      level: 'info',
      scope: 'vault',
      message: `Remapped ${plan.aliasedRecords} record(s) to current checkout paths.`,
    })
  }
  if (plan.unmanagedStoreFiles.length > 0) {
    emitDiagnostic({
      code: 'VAULT_UNMANAGED_FILES_IGNORED',
      level: 'warning',
      scope: 'vault',
      message: `Ignored ${plan.unmanagedStoreFiles.length} unmanaged store file(s).`,
    })
  }
}

export function applyRestoreFailOn(plan: RestorePlan, value: string | undefined): void {
  const condition = parseVaultFailCondition(value)
  if (restorePlanMatchesFailCondition(plan, condition)) process.exitCode = 2
}
