import { EnvLaneError } from '@env-lane/core'
import type { RestorePlanEntry, VaultConflictStrategy } from '../domain/types.js'

/** Resolve a conflict requested by the JS callback boundary of a native Vault operation. */
export async function resolveConflict(
  strategy: VaultConflictStrategy | undefined,
  entry: RestorePlanEntry,
  resolver?: (
    entry: RestorePlanEntry,
  ) => Promise<'keep-local' | 'take-vault'> | 'keep-local' | 'take-vault',
): Promise<'keep-local' | 'take-vault'> {
  const effectiveStrategy = strategy ?? 'abort'
  if (effectiveStrategy === 'keep-local' || effectiveStrategy === 'take-vault') {
    return effectiveStrategy
  }
  if (resolver) {
    const choice = await resolver(entry)
    if (choice === 'keep-local' || choice === 'take-vault') return choice
    throw new EnvLaneError(
      'VAULT_INVALID_DECISION',
      `Conflict resolver returned an invalid choice for ${entry.entryId}.`,
    )
  }
  throw new EnvLaneError(
    'VAULT_CONFLICT_DECISION_REQUIRED',
    'Vault conflict resolution requires a decision map, resolveConflict callback, or an explicit non-interactive strategy.',
    { entryId: entry.entryId, filePath: entry.filePath, key: entry.key },
  )
}
