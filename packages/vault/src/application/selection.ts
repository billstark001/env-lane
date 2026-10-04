import { EnvLaneError } from '@env-lane/core'
import type { RestorePlanEntry } from '../domain/types.js'

/** Selection callbacks are synchronous; reject promises and truthy non-booleans. */
export function selectEntryWithCallback(
  callback: (entry: RestorePlanEntry) => boolean,
  entry: RestorePlanEntry,
): boolean {
  const selected = callback(entry)
  if (typeof selected !== 'boolean') {
    throw new EnvLaneError(
      'VAULT_INVALID_DECISION',
      `Selection callback must return a boolean for ${entry.entryId}.`,
    )
  }
  return selected
}
