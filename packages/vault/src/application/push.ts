import { existsSync } from 'node:fs'
import { loadEnvDocument } from '@env-lane/core/env-document'
import { loadVaultConfig, type VaultConfig } from '../adapters/config.js'
import { deriveVaultKey, keyedDigest } from '../adapters/crypto.js'
import { type AbsolutePath, resolveFromDirectory, resolveInvocationCwd } from '../adapters/paths.js'
import type { RestorePlanEntry, VaultConflictStrategy, VaultRecord } from '../domain/types.js'
import {
  appendRecordsAtomically,
  assertNoExcludedHistory,
  isExcluded,
  portable,
  readStore,
  type StoreReadResult,
  withVaultOperationLock,
} from './storage.js'
import {
  loadSyncContext,
  pushConflictCheck,
  resolveConflict,
  type SyncContext,
  saveSyncContext,
  scrubExcludedSyncEntries,
  updateSyncEntry,
  valueFingerprint,
} from './sync.js'

export interface EncryptOptions {
  cwd?: string
  dryRun?: boolean
  ignoreCorruptRecords?: boolean
  syncDir?: string
  conflictStrategy?: VaultConflictStrategy
  vaultConfigFile?: string
  autoRemapPaths?: boolean
  allowUnmanaged?: boolean
  resolvedConfig?: VaultConfig
  selectEntry?: (entry: RestorePlanEntry) => boolean
  resolveConflict?: (
    entry: RestorePlanEntry,
  ) => Promise<'keep-local' | 'take-vault'> | 'keep-local' | 'take-vault'
}

interface VaultChange {
  action: 'set' | 'update' | 'delete'
  filePath: string
  key: string
}

interface EncryptAccumulator {
  pendingRecords: VaultRecord[]
  changes: VaultChange[]
  setRecordsWritten: number
  deleteRecordsWritten: number
  skippedUnchanged: number
  localOnlyEntriesSkipped: number
  missingFilesSkipped: number
  invalidLinesIgnored: number
  shadowedEntriesIgnored: number
  selectionSkipped: number
  conflicts: number
  conflictsKeptLocal: number
  conflictsTookVault: number
}

function createEncryptAccumulator(): EncryptAccumulator {
  return {
    pendingRecords: [],
    changes: [],
    setRecordsWritten: 0,
    deleteRecordsWritten: 0,
    skippedUnchanged: 0,
    localOnlyEntriesSkipped: 0,
    missingFilesSkipped: 0,
    invalidLinesIgnored: 0,
    shadowedEntriesIgnored: 0,
    selectionSkipped: 0,
    conflicts: 0,
    conflictsKeptLocal: 0,
    conflictsTookVault: 0,
  }
}

async function shouldWritePushEntry(
  entry: RestorePlanEntry,
  options: EncryptOptions,
  accumulator: EncryptAccumulator,
): Promise<boolean> {
  if (options.selectEntry && !options.selectEntry(entry)) {
    accumulator.selectionSkipped++
    return false
  }
  if (!entry.conflict) return true
  accumulator.conflicts++
  const decision = await resolveConflict(options.conflictStrategy, entry, options.resolveConflict)
  if (decision === 'take-vault') {
    accumulator.conflictsTookVault++
    return false
  }
  accumulator.conflictsKeptLocal++
  return true
}

async function processCurrentEntry(
  config: VaultConfig,
  key: Buffer,
  syncContext: SyncContext | undefined,
  filePath: string,
  keyName: string,
  effectiveValue: string,
  old: VaultRecord | undefined,
  options: EncryptOptions,
  accumulator: EncryptAccumulator,
): Promise<void> {
  if (old?.op === 'set' && old.v === effectiveValue) {
    accumulator.skippedUnchanged++
    updateSyncEntry(config, syncContext, old)
    return
  }
  const conflict = pushConflictCheck(
    config,
    syncContext,
    filePath,
    keyName,
    syncContext ? valueFingerprint(syncContext.syncKey, 'set', effectiveValue) : '',
    old,
  )
  const entry: RestorePlanEntry = {
    entryId: keyedDigest(
      key,
      JSON.stringify({ direction: 'encrypt', filePath, key: keyName, value: effectiveValue }),
    ),
    filePath,
    key: keyName,
    action: conflict.conflict ? 'conflict' : old?.op === 'set' ? 'modify' : 'add',
    occurrenceCount: 1,
    conflict: conflict.conflict,
    vaultAction: old?.op === 'set' ? 'modify' : 'add',
    conflictReason: conflict.reason,
    preview: { current: '<redacted>', vault: old?.op === 'set' ? '<redacted>' : '<missing>' },
  }
  if (!(await shouldWritePushEntry(entry, options, accumulator))) return
  const record: VaultRecord = {
    version: 1,
    f: filePath,
    k: keyName,
    v: effectiveValue,
    op: 'set',
    t: Date.now(),
  }
  accumulator.pendingRecords.push(record)
  updateSyncEntry(config, syncContext, record)
  accumulator.changes.push({
    action: old?.op === 'set' ? 'update' : 'set',
    filePath: portable(filePath),
    key: keyName,
  })
  accumulator.setRecordsWritten++
}

async function processDeletedEntry(
  config: VaultConfig,
  key: Buffer,
  syncContext: SyncContext | undefined,
  filePath: string,
  keyName: string,
  old: VaultRecord,
  options: EncryptOptions,
  accumulator: EncryptAccumulator,
): Promise<void> {
  const conflict = pushConflictCheck(
    config,
    syncContext,
    filePath,
    keyName,
    syncContext ? valueFingerprint(syncContext.syncKey, 'delete') : '',
    old,
  )
  const entry: RestorePlanEntry = {
    entryId: keyedDigest(
      key,
      JSON.stringify({ direction: 'encrypt', filePath, key: keyName, op: 'delete' }),
    ),
    filePath,
    key: keyName,
    action: conflict.conflict ? 'conflict' : 'delete',
    occurrenceCount: 0,
    conflict: conflict.conflict,
    vaultAction: 'delete',
    conflictReason: conflict.reason,
    preview: { current: '<missing>', vault: '<redacted>' },
  }
  if (!(await shouldWritePushEntry(entry, options, accumulator))) return
  const record: VaultRecord = {
    version: 1,
    f: filePath,
    k: keyName,
    op: 'delete',
    t: Date.now(),
  }
  accumulator.pendingRecords.push(record)
  updateSyncEntry(config, syncContext, record)
  accumulator.changes.push({ action: 'delete', filePath: portable(filePath), key: keyName })
  accumulator.deleteRecordsWritten++
}

async function processEnvFileForEncryption(
  config: VaultConfig,
  key: Buffer,
  syncContext: SyncContext | undefined,
  state: StoreReadResult['state'],
  filePath: string,
  options: EncryptOptions,
  accumulator: EncryptAccumulator,
): Promise<void> {
  if (!existsSync(filePath)) {
    accumulator.missingFilesSkipped++
    return
  }
  const envDoc = loadEnvDocument(filePath)
  const previous = state.get(filePath) ?? new Map<string, VaultRecord>()
  const current = new Map<string, string>()
  for (const [keyName, { effectiveValue }] of envDoc.currentMap) {
    if (isExcluded(config, filePath, keyName)) {
      accumulator.localOnlyEntriesSkipped++
      continue
    }
    current.set(keyName, effectiveValue)
    await processCurrentEntry(
      config,
      key,
      syncContext,
      filePath,
      keyName,
      effectiveValue,
      previous.get(keyName),
      options,
      accumulator,
    )
  }
  if (config.trackDeletions) {
    for (const [keyName, old] of previous) {
      if (!isExcluded(config, filePath, keyName) && old.op === 'set' && !current.has(keyName)) {
        await processDeletedEntry(
          config,
          key,
          syncContext,
          filePath,
          keyName,
          old,
          options,
          accumulator,
        )
      }
    }
  }
  for (const [keyName, old] of previous) {
    if (old.op === 'delete' && !current.has(keyName)) updateSyncEntry(config, syncContext, old)
  }
  accumulator.invalidLinesIgnored += envDoc.invalidLineCount
  accumulator.shadowedEntriesIgnored += envDoc.shadowedEntryCount
}

async function encryptEnvFilesLocked(
  config: VaultConfig,
  key: Buffer,
  syncDir: AbsolutePath | undefined,
  options: EncryptOptions,
) {
  const syncContext = loadSyncContext(syncDir, key)
  scrubExcludedSyncEntries(config, syncContext)
  const store = readStore(config, key, {
    allowMissing: true,
    ignoreCorruptRecords: options.ignoreCorruptRecords,
  })
  assertNoExcludedHistory(config, store.records, store.failedRecords)
  const accumulator = createEncryptAccumulator()
  for (const filePath of config.envFiles) {
    await processEnvFileForEncryption(
      config,
      key,
      syncContext,
      store.state,
      filePath,
      options,
      accumulator,
    )
  }
  if (!options.dryRun) {
    await appendRecordsAtomically(config, key, accumulator.pendingRecords)
    if (syncContext) await saveSyncContext(syncContext)
  }
  return {
    applied: !options.dryRun && accumulator.pendingRecords.length > 0,
    dryRun: options.dryRun ?? false,
    storePath: config.storePath,
    setRecordsWritten: accumulator.setRecordsWritten,
    deleteRecordsWritten: accumulator.deleteRecordsWritten,
    skippedUnchanged: accumulator.skippedUnchanged,
    localOnlyEntriesSkipped: accumulator.localOnlyEntriesSkipped,
    missingFilesSkipped: accumulator.missingFilesSkipped,
    invalidLinesIgnored: accumulator.invalidLinesIgnored,
    shadowedEntriesIgnored: accumulator.shadowedEntriesIgnored,
    selectionSkipped: accumulator.selectionSkipped,
    rawRecords: store.rawRecords,
    parsedRecords: store.parsedRecords,
    failedRecords: store.failedRecords,
    aliasedRecords: store.aliasedRecords,
    conflicts: accumulator.conflicts,
    conflictsKeptLocal: accumulator.conflictsKeptLocal,
    conflictsTookVault: accumulator.conflictsTookVault,
    changes: accumulator.changes,
    syncStatePath: syncContext?.statePath,
    syncStateMigratedFromVersion0: syncContext?.migratedFromVersion0 ?? false,
  }
}

export async function encryptEnvFiles(
  configPath: string | undefined,
  keyFilePath: string,
  options: EncryptOptions = {},
) {
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const config =
    options.resolvedConfig ??
    (await loadVaultConfig(configPath, { ...options, cwd: invocationCwd }))
  const key = deriveVaultKey(resolveFromDirectory(invocationCwd, keyFilePath))
  const syncDir = options.syncDir ? resolveFromDirectory(invocationCwd, options.syncDir) : undefined
  if (options.dryRun) return encryptEnvFilesLocked(config, key, syncDir, options)
  return withVaultOperationLock(config, () => encryptEnvFilesLocked(config, key, syncDir, options))
}
