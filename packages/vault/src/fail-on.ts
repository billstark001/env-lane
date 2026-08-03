import { EnvLaneError } from '@env-lane/core'
import type { RestorePlan } from './store.js'

export type VaultFailCondition = 'conflict' | 'change' | 'warning'

export function parseVaultFailCondition(value: string | undefined): VaultFailCondition | undefined {
  if (value === undefined) return undefined
  if (value === 'conflict' || value === 'change' || value === 'warning') return value
  throw new EnvLaneError('VAULT_INVALID_FAIL_ON', '--fail-on must be conflict, change, or warning.')
}

export function restorePlanMatchesFailCondition(
  plan: RestorePlan,
  condition: VaultFailCondition | undefined,
): boolean {
  if (condition === 'conflict') return plan.summary.conflict > 0
  if (condition === 'change') return plan.summary.filesWithChanges > 0
  if (condition === 'warning') {
    return plan.failedRecords > 0 || plan.unmanagedStoreFiles.length > 0
  }
  return false
}
