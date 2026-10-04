import { loadVaultConfig, type VaultConfig } from '../adapters/config.js'
import { callNativeVault } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
import type {
  RestorePlanEntry,
  VaultConflictStrategy,
  VaultMissingFileStrategy,
} from '../domain/types.js'
import { selectEntryWithCallback } from './selection.js'
import { withVaultOperationLock } from './storage.js'
import { resolveConflict } from './sync.js'

export interface EncryptOptions {
  cwd?: string
  dryRun?: boolean
  ignoreCorruptRecords?: boolean
  syncDir?: string
  conflictStrategy?: VaultConflictStrategy
  vaultConfigFile?: string
  autoRemapPaths?: boolean
  allowUnmanaged?: boolean
  missingFiles?: VaultMissingFileStrategy
  resolvedConfig?: VaultConfig
  selectEntry?: (entry: RestorePlanEntry) => boolean
  resolveConflict?: (
    entry: RestorePlanEntry,
  ) => Promise<'keep-local' | 'take-vault'> | 'keep-local' | 'take-vault'
}

interface PushChange {
  action: 'set' | 'update' | 'delete'
  filePath: string
  key: string
}

export interface PushResult {
  applied: boolean
  dryRun: boolean
  storePath: string
  setRecordsWritten: number
  deleteRecordsWritten: number
  skippedUnchanged: number
  localOnlyEntriesSkipped: number
  missingFilesSkipped: number
  missingFilesTreatedAsEmpty: number
  invalidLinesIgnored: number
  shadowedEntriesIgnored: number
  selectionSkipped: number
  rawRecords: number
  parsedRecords: number
  failedRecords: number
  aliasedRecords: number
  conflicts: number
  conflictsKeptLocal: number
  conflictsTookVault: number
  changes: PushChange[]
  syncStatePath?: string
  syncStateMigratedFromVersion0: boolean
}

interface FrozenDocument {
  filePath: string
  exists: boolean
  content: string
}

interface PushPreview extends PushResult {
  candidates: RestorePlanEntry[]
  frozenDocuments: FrozenDocument[]
}

/**
 * Compare managed dotenv values with Vault history and append changed records.
 * A dry run writes nothing. With callbacks, a native snapshot is held under the
 * operation lock until their decisions are applied.
 */
export async function encryptEnvFiles(
  configPath: string | undefined,
  keyFilePath: string,
  options: EncryptOptions = {},
): Promise<PushResult> {
  const cwd = resolveInvocationCwd(options.cwd)
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, { ...options, cwd }))
  const request = {
    cwd,
    keyFile: keyFilePath,
    config,
    dryRun: options.dryRun,
    ignoreCorruptRecords: options.ignoreCorruptRecords,
    syncDir: options.syncDir,
    conflictStrategy: options.conflictStrategy,
    missingFiles: options.missingFiles,
  }
  if (!options.selectEntry && !options.resolveConflict) {
    return callNativeVault<PushResult>('vault.encryptEnvFiles', request)
  }

  const execute = async (): Promise<PushResult> => {
    // Keep one cross-process lock from snapshot through callbacks and apply. The
    // native apply consumes the snapshot even if a callback edits an env file.
    const preview = callNativeVault<PushPreview>('vault.encryptEnvFiles', {
      ...request,
      dryRun: true,
      conflictStrategy: 'keep-local',
      capturePushPreview: true,
      skipOperationLock: true,
    })
    const pushDecisions: Record<string, { selected: boolean; conflictChoice?: string }> = {}
    for (const entry of preview.candidates) {
      const selected = options.selectEntry
        ? selectEntryWithCallback(options.selectEntry, entry)
        : true
      const conflictChoice =
        selected && entry.conflict
          ? await resolveConflict(options.conflictStrategy, entry, options.resolveConflict)
          : undefined
      pushDecisions[entry.entryId] = { selected, conflictChoice }
    }
    return callNativeVault<PushResult>('vault.encryptEnvFiles', {
      ...request,
      frozenDocuments: preview.frozenDocuments,
      pushDecisions,
      skipOperationLock: true,
    })
  }
  return options.dryRun ? execute() : withVaultOperationLock(config, execute)
}
