import { EnvLaneError } from '@env-lane/core'
import { loadVaultConfig, type VaultConfig } from '../adapters/config.js'
import { callNativeVault } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'

interface HistoryOptions {
  cwd?: string
  dryRun?: boolean
  autoApprove?: boolean
  vaultConfigFile?: string
  resolvedConfig?: VaultConfig
  expectedStoreDigest?: string
}

interface PruneOptions extends HistoryOptions {
  filePath?: string
  key?: string
  keepRecent?: number
  olderThanDays?: number
  preserveLatest?: boolean
  ignoreCorruptRecords?: boolean
}

interface SanitizeOptions extends HistoryOptions {
  excluded?: boolean
}

interface HistoryResult {
  storePath: string
  storeDigest: string
  removedRecords: number
  keptRecords: number
  applied: boolean
}

interface PruneResult extends HistoryResult {
  rawRecords: number
  parsedRecords: number
  failedRecords: number
  aliasedRecords: number
  groups: number
}

interface SanitizeResult extends HistoryResult {
  affectedEntries: string[]
}

/** Preview or prune authenticated Vault history according to an age or count limit. */
export async function pruneVaultHistory(
  configPath: string | undefined,
  keyFilePath: string,
  options: PruneOptions = {},
): Promise<PruneResult> {
  if (options.keepRecent === undefined && options.olderThanDays === undefined) {
    throw new EnvLaneError(
      'VAULT_INVALID_PRUNE_OPTIONS',
      'History prune requires --keep-recent or --older-than-days.',
    )
  }
  if (
    options.keepRecent !== undefined &&
    (!Number.isInteger(options.keepRecent) || options.keepRecent < 1)
  ) {
    throw new EnvLaneError('VAULT_INVALID_PRUNE_OPTIONS', 'keepRecent must be a positive integer.')
  }
  if (
    options.olderThanDays !== undefined &&
    (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 0)
  ) {
    throw new EnvLaneError(
      'VAULT_INVALID_PRUNE_OPTIONS',
      'olderThanDays must be a non-negative number.',
    )
  }
  const cwd = resolveInvocationCwd(options.cwd)
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  return callNativeVault<PruneResult>('vault.pruneVaultHistory', {
    cwd,
    config,
    keyFile: keyFilePath,
    dryRun: options.dryRun,
    autoApprove: options.autoApprove,
    expectedStoreDigest: options.expectedStoreDigest,
    filePath: options.filePath,
    key: options.key,
    keepRecent: options.keepRecent,
    olderThanDays: options.olderThanDays,
    preserveLatest: options.preserveLatest,
    ignoreCorruptRecords: options.ignoreCorruptRecords,
  })
}

/** Remove records matching the configured local-only exclusion rules. */
export async function sanitizeVaultHistory(
  configPath: string | undefined,
  keyFilePath: string,
  options: SanitizeOptions = {},
): Promise<SanitizeResult> {
  if (!options.excluded) {
    throw new EnvLaneError(
      'VAULT_SANITIZE_SCOPE_REQUIRED',
      'Vault sanitize requires --excluded so the removal scope is explicit.',
    )
  }
  const cwd = resolveInvocationCwd(options.cwd)
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  return callNativeVault<SanitizeResult>('vault.sanitizeVaultHistory', {
    cwd,
    config,
    keyFile: keyFilePath,
    dryRun: options.dryRun,
    autoApprove: options.autoApprove,
    expectedStoreDigest: options.expectedStoreDigest,
    excluded: options.excluded,
  })
}
