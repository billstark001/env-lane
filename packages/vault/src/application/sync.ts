import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError, writeFileContentAtomically } from '@env-lane/core'
import type { LoadedEnvDocument } from '@env-lane/core/env-document'
import type { VaultConfig } from '../adapters/config.js'
import { deriveVaultSyncKey, stableHash } from '../adapters/crypto.js'
import { withFileLock } from '../adapters/file-lock.js'
import { type AbsolutePath, resolveFromDirectory } from '../adapters/paths.js'
import type {
  RestorePlanEntry,
  VaultConflictStrategy,
  VaultOperation,
  VaultRecord,
} from '../domain/types.js'
import { isExcluded, portable } from './storage.js'

interface SyncStateEntry {
  filePath: string
  key: string
  op: VaultOperation
  valueFingerprint: string
  vaultTimestamp: number
  syncedAt: number
}

interface SyncState {
  version: 1
  fingerprint: 'hmac-sha256'
  entries: Record<string, SyncStateEntry>
}

export interface SyncContext {
  syncDir: AbsolutePath
  statePath: AbsolutePath
  state: SyncState
  initialEntries: Record<string, SyncStateEntry>
  syncKey: Buffer
  migratedFromVersion0: boolean
}

interface ConflictCheck {
  conflict: boolean
  reason?: string
}

const SYNC_STATE_FILE = 'vault-sync-state.json'

export function valueFingerprint(syncKey: Buffer, op: VaultOperation, value?: string): string {
  return createHmac('sha256', syncKey)
    .update(JSON.stringify({ op, v: op === 'set' ? (value ?? '') : undefined }))
    .digest('hex')
}

export function recordValueFingerprint(
  syncKey: Buffer,
  record: Pick<VaultRecord, 'op' | 'v'>,
): string {
  return valueFingerprint(syncKey, record.op, record.v)
}

function syncEntryId(config: VaultConfig, filePath: string, key: string): string {
  return stableHash(`${portable(path.relative(config.baseDir, filePath))}\0${key}`)
}

function syncStateFilePath(syncDir: AbsolutePath): AbsolutePath {
  return resolveFromDirectory(syncDir, SYNC_STATE_FILE)
}

function emptySyncState(): SyncState {
  return { version: 1, fingerprint: 'hmac-sha256', entries: {} }
}

export function loadSyncContext(
  syncDir: AbsolutePath | undefined,
  vaultKey: Buffer,
): SyncContext | undefined {
  if (!syncDir) return undefined
  const statePath = syncStateFilePath(syncDir)
  const syncKey = deriveVaultSyncKey(vaultKey)
  if (!existsSync(statePath))
    return {
      syncDir,
      statePath,
      state: emptySyncState(),
      initialEntries: {},
      syncKey,
      migratedFromVersion0: false,
    }
  const parsed = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvLaneError(
      'VAULT_INVALID_SYNC_STATE',
      `Invalid vault sync state file: ${statePath}`,
    )
  }
  const raw = parsed as Record<string, unknown>
  if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
    throw new EnvLaneError(
      'VAULT_UNSUPPORTED_SYNC_STATE',
      `Unsupported vault sync state file: ${statePath}`,
    )
  }
  const entries = Object.values(raw.entries as Record<string, unknown>)
  const isLegacyVersion0 =
    raw.version === undefined ||
    raw.version === 0 ||
    (raw.version === 1 &&
      raw.fingerprint === undefined &&
      entries.every(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          'valueHash' in (entry as Record<string, unknown>) &&
          !('valueFingerprint' in (entry as Record<string, unknown>)),
      ))
  if (isLegacyVersion0) {
    return {
      syncDir,
      statePath,
      state: emptySyncState(),
      initialEntries: {},
      syncKey,
      migratedFromVersion0: true,
    }
  }
  if (raw.version !== 1 || raw.fingerprint !== 'hmac-sha256') {
    throw new EnvLaneError(
      'VAULT_UNSUPPORTED_SYNC_STATE',
      `Unsupported vault sync state file: ${statePath}`,
    )
  }
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).valueFingerprint !== 'string'
    ) {
      throw new EnvLaneError(
        'VAULT_INVALID_SYNC_STATE',
        `Invalid vault sync state entry: ${statePath}`,
      )
    }
  }
  return {
    syncDir,
    statePath,
    state: raw as unknown as SyncState,
    initialEntries: structuredClone((raw as unknown as SyncState).entries),
    syncKey,
    migratedFromVersion0: false,
  }
}

export async function saveSyncContext(context: SyncContext): Promise<void> {
  await withFileLock(context.statePath, () => {
    let latest = emptySyncState()
    if (existsSync(context.statePath)) {
      const parsed = JSON.parse(
        readFileSync(context.statePath, 'utf8').replace(/^\uFEFF/, ''),
      ) as SyncState
      if (parsed.version !== 1 || parsed.fingerprint !== 'hmac-sha256') {
        if (!context.migratedFromVersion0) {
          throw new EnvLaneError(
            'VAULT_SYNC_STATE_CHANGED',
            `Vault sync state changed to an unsupported format: ${context.statePath}`,
          )
        }
      } else {
        latest = parsed
      }
    }
    for (const entryId of Object.keys(context.initialEntries)) {
      if (!(entryId in context.state.entries)) delete latest.entries[entryId]
    }
    for (const [entryId, entry] of Object.entries(context.state.entries)) {
      const initial = context.initialEntries[entryId]
      if (!initial || JSON.stringify(initial) !== JSON.stringify(entry)) {
        latest.entries[entryId] = entry
      }
    }
    writeFileContentAtomically(context.statePath, `${JSON.stringify(latest, null, 2)}\n`)
  })
}

export function updateSyncEntry(
  config: VaultConfig,
  context: SyncContext | undefined,
  record: VaultRecord,
): void {
  if (!context) return
  const id = syncEntryId(config, record.f, record.k)
  context.state.entries[id] = {
    filePath: portable(path.relative(config.baseDir, record.f)),
    key: record.k,
    op: record.op,
    valueFingerprint: recordValueFingerprint(context.syncKey, record),
    vaultTimestamp: record.t,
    syncedAt: Date.now(),
  }
}

export function scrubExcludedSyncEntries(
  config: VaultConfig,
  context: SyncContext | undefined,
): void {
  if (!context) return
  for (const [id, entry] of Object.entries(context.state.entries)) {
    const filePath = path.resolve(config.baseDir, entry.filePath)
    if (isExcluded(config, filePath, entry.key)) delete context.state.entries[id]
  }
}

function hasDivergedFromSyncEntry(
  config: VaultConfig,
  context: SyncContext | undefined,
  filePath: string,
  key: string,
  localFingerprint: string,
  vaultFingerprint: string,
): ConflictCheck {
  if (!context) return { conflict: false }
  const entry = context.state.entries[syncEntryId(config, filePath, key)]
  if (!entry) {
    return localFingerprint === vaultFingerprint
      ? { conflict: false }
      : { conflict: true, reason: 'local and vault differ without a sync baseline' }
  }
  const localChanged = localFingerprint !== entry.valueFingerprint
  const vaultChanged = vaultFingerprint !== entry.valueFingerprint
  return localChanged && vaultChanged && localFingerprint !== vaultFingerprint
    ? { conflict: true, reason: 'local and vault both changed since the last sync' }
    : { conflict: false }
}

export function restoreConflictCheck(
  config: VaultConfig,
  context: SyncContext | undefined,
  filePath: string,
  key: string,
  envDoc: LoadedEnvDocument,
  record: VaultRecord,
): ConflictCheck {
  if (!context) return { conflict: false }
  const localFingerprint = localValueFingerprintForEnvDoc(context.syncKey, envDoc, key)
  const vaultFingerprint = recordValueFingerprint(context.syncKey, record)
  return hasDivergedFromSyncEntry(
    config,
    context,
    filePath,
    key,
    localFingerprint,
    vaultFingerprint,
  )
}

export function pushConflictCheck(
  config: VaultConfig,
  context: SyncContext | undefined,
  filePath: string,
  key: string,
  localFingerprint: string,
  previousRecord: VaultRecord | undefined,
): ConflictCheck {
  if (!context || !previousRecord) return { conflict: false }
  const vaultFingerprint = recordValueFingerprint(context.syncKey, previousRecord)
  return hasDivergedFromSyncEntry(
    config,
    context,
    filePath,
    key,
    localFingerprint,
    vaultFingerprint,
  )
}

export function localValueFingerprintForEnvDoc(
  syncKey: Buffer,
  envDoc: LoadedEnvDocument,
  key: string,
): string {
  const current = envDoc.currentMap.get(key)
  return current
    ? valueFingerprint(syncKey, 'set', current.effectiveValue)
    : valueFingerprint(syncKey, 'delete')
}

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
  if (resolver) return resolver(entry)
  throw new EnvLaneError(
    'VAULT_CONFLICT_DECISION_REQUIRED',
    'Vault conflict resolution requires a decision map, resolveConflict callback, or an explicit non-interactive strategy.',
    { entryId: entry.entryId, filePath: entry.filePath, key: entry.key },
  )
}
