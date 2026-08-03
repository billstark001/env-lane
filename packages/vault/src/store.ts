/// <reference path="./picomatch.d.ts" />

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  applyEnvDocumentPatches,
  EnvLaneError,
  type LoadedEnvDocument,
  loadEnvDocument,
  parseEnvLine,
  writeFileContentAtomically,
} from '@env-lane/core'
import picomatch from 'picomatch'
import { loadVaultConfig, type VaultConfig } from './config.js'
import { decryptRecord, deriveVaultKey, deriveVaultSyncKey, encryptRecord } from './crypto.js'
import { withFileLock } from './file-lock.js'

export type VaultOperation = 'set' | 'delete'
export type RestoreAction = 'add' | 'modify' | 'delete' | 'identical' | 'conflict'
export type VaultConflictStrategy = 'abort' | 'keep-local' | 'take-vault'
export type RestoreDecisionChoice = 'apply-vault' | 'keep-local' | 'skip'

export interface RestoreDecision {
  entryId: string
  decision: RestoreDecisionChoice
}

export interface VaultRecord {
  version: 0 | 1
  f: string
  k: string
  t: number
  op: VaultOperation
  v?: string
  order?: number
}

export interface RestorePlanEntry {
  entryId: string
  filePath: string
  key: string
  action: RestoreAction
  occurrenceCount: number
  conflict?: boolean
  vaultAction?: Exclude<RestoreAction, 'conflict'>
  conflictReason?: string
  preview: {
    current: string
    vault: string
  }
}

export interface RestorePlanFile {
  filePath: string
  entries: RestorePlanEntry[]
  changed: boolean
}

export interface RestorePlan {
  version: 1
  createdAt: number
  planDigest: string
  storeDigest: string
  storePath: string
  files: RestorePlanFile[]
  summary: Record<RestoreAction, number> & { filesWithChanges: number }
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
  unmanagedStoreFiles: string[]
}

interface InternalRestorePlanEntry extends RestorePlanEntry {
  currentValues: string[]
  nextValue?: string
}

interface InternalRestorePlanFile extends Omit<RestorePlanFile, 'entries'> {
  entries: InternalRestorePlanEntry[]
}

interface InternalRestorePlan extends Omit<RestorePlan, 'files'> {
  files: InternalRestorePlanFile[]
}

interface StoreReadResult {
  records: StoreRecordLine[]
  state: Map<string, Map<string, VaultRecord>>
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
}

interface StoreRecordLine {
  encryptedLine: string
  lineIndex: number
  record: VaultRecord
  groupFilePath: string
}

interface StoreRecordsReadResult {
  records: StoreRecordLine[]
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
  rawLines: string[]
}

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

interface SyncContext {
  syncDir: string
  statePath: string
  state: SyncState
  initialEntries: Record<string, SyncStateEntry>
  syncKey: Buffer
  migratedFromVersion0: boolean
}

interface ConflictCheck {
  conflict: boolean
  reason?: string
}

interface PruneCandidate {
  index: number
  record: VaultRecord
}

const SYNC_STATE_FILE = 'vault-sync-state.json'

type PicomatchMatcher = ReturnType<typeof picomatch>

interface CompiledExcludeRule {
  fileMatch: PicomatchMatcher
  keyMatch: PicomatchMatcher
}

interface ManagedFileAlias {
  filePath: string
  relativePath: string
}

const excludeRuleCache = new WeakMap<VaultConfig, CompiledExcludeRule[]>()
const managedFileAliasCache = new WeakMap<VaultConfig, ManagedFileAlias[]>()

function portable(file: string): string {
  return file.replace(/\\/g, '/').replaceAll(path.sep, '/')
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function keyedDigest(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex')
}

function valueFingerprint(syncKey: Buffer, op: VaultOperation, value?: string): string {
  return createHmac('sha256', syncKey)
    .update(JSON.stringify({ op, v: op === 'set' ? (value ?? '') : undefined }))
    .digest('hex')
}

function recordValueFingerprint(syncKey: Buffer, record: Pick<VaultRecord, 'op' | 'v'>): string {
  return valueFingerprint(syncKey, record.op, record.v)
}

function syncEntryId(config: VaultConfig, filePath: string, key: string): string {
  return stableHash(`${portable(path.relative(config.baseDir, filePath))}\0${key}`)
}

function syncStateFilePath(syncDir: string): string {
  return path.join(path.resolve(syncDir), SYNC_STATE_FILE)
}

function emptySyncState(): SyncState {
  return { version: 1, fingerprint: 'hmac-sha256', entries: {} }
}

function loadSyncContext(syncDir: string | undefined, vaultKey: Buffer): SyncContext | undefined {
  if (!syncDir) return undefined
  const resolvedSyncDir = path.resolve(syncDir)
  const statePath = syncStateFilePath(resolvedSyncDir)
  const syncKey = deriveVaultSyncKey(vaultKey)
  if (!existsSync(statePath))
    return {
      syncDir: resolvedSyncDir,
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
      syncDir: resolvedSyncDir,
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
    syncDir: resolvedSyncDir,
    statePath,
    state: raw as unknown as SyncState,
    initialEntries: structuredClone((raw as unknown as SyncState).entries),
    syncKey,
    migratedFromVersion0: false,
  }
}

async function saveSyncContext(context: SyncContext): Promise<void> {
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

function updateSyncEntry(
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

function scrubExcludedSyncEntries(config: VaultConfig, context: SyncContext | undefined): void {
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

function restoreConflictCheck(
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

function pushConflictCheck(
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

function localValueFingerprintForEnvDoc(
  syncKey: Buffer,
  envDoc: LoadedEnvDocument,
  key: string,
): string {
  const current = envDoc.currentMap.get(key)
  return current
    ? valueFingerprint(syncKey, 'set', current.effectiveValue)
    : valueFingerprint(syncKey, 'delete')
}

function getCompiledExcludeRules(config: VaultConfig): CompiledExcludeRule[] {
  const cached = excludeRuleCache.get(config)
  if (cached) return cached
  const compiled = config.exclude.map((rule) => ({
    fileMatch: picomatch(rule.files, { dot: true }),
    keyMatch: picomatch(rule.keys, { dot: true }),
  }))
  excludeRuleCache.set(config, compiled)
  return compiled
}

function isExcluded(config: VaultConfig, filePath: string, key: string): boolean {
  const rel = portable(path.relative(config.baseDir, filePath))
  for (const { fileMatch, keyMatch } of getCompiledExcludeRules(config)) {
    if ((fileMatch(rel) || fileMatch(path.basename(filePath))) && keyMatch(key)) return true
  }
  return false
}

function isNewerRecord(candidate: VaultRecord, existing: VaultRecord): boolean {
  if (candidate.t !== existing.t) return candidate.t > existing.t
  return (candidate.order ?? 0) > (existing.order ?? 0)
}

function getManagedFileAliases(config: VaultConfig): ManagedFileAlias[] {
  const cached = managedFileAliasCache.get(config)
  if (cached) return cached
  const aliases = [...new Set(config.envFiles.map((filePath) => path.resolve(filePath)))].map(
    (filePath) => ({
      filePath,
      relativePath: portable(path.relative(config.baseDir, filePath)),
    }),
  )
  managedFileAliasCache.set(config, aliases)
  return aliases
}

function remapManagedStoreFilePath(
  filePath: string,
  config: VaultConfig,
): { filePath: string; aliased: boolean } {
  const resolvedFilePath = path.resolve(filePath)
  if (!config.autoRemapPaths) {
    return { filePath: resolvedFilePath, aliased: false }
  }
  const aliases = getManagedFileAliases(config)
  if (aliases.some((alias) => alias.filePath === resolvedFilePath)) {
    return { filePath: resolvedFilePath, aliased: false }
  }

  const portableFilePath = portable(resolvedFilePath)
  let matchedAlias: { filePath: string; relativePath: string } | undefined
  for (const alias of aliases) {
    if (!alias.relativePath || alias.relativePath.startsWith('..')) continue
    if (
      portableFilePath === alias.relativePath ||
      portableFilePath.endsWith(`/${alias.relativePath}`)
    ) {
      if (!matchedAlias || alias.relativePath.length > matchedAlias.relativePath.length) {
        matchedAlias = alias
      }
    }
  }
  return matchedAlias
    ? { filePath: matchedAlias.filePath, aliased: true }
    : { filePath: resolvedFilePath, aliased: false }
}

function validateStoreRecord(decoded: unknown, order: number): VaultRecord {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Store record must be a JSON object.')
  }
  const raw = decoded as Record<string, unknown>
  const version = raw.version === undefined ? 0 : raw.version
  if (version !== 0 && version !== 1)
    throw new Error('Store record has unsupported schema version.')
  if (typeof raw.f !== 'string' || !raw.f.trim())
    throw new Error('Store record is missing file path.')
  if (typeof raw.k !== 'string' || !raw.k.trim())
    throw new Error('Store record is missing key name.')
  const timestamp = Number(raw.t)
  if (!Number.isFinite(timestamp) || timestamp < 0)
    throw new Error('Store record has invalid timestamp.')
  const op = raw.op === undefined ? 'set' : raw.op
  if (op !== 'set' && op !== 'delete')
    throw new Error(`Unsupported record operation: ${String(op)}`)
  if (op === 'set' && typeof raw.v !== 'string')
    throw new Error('Set record is missing string value.')
  let value = op === 'set' ? (raw.v as string) : undefined
  if (version === 0 && value !== undefined) {
    const parsed = parseEnvLine(`${raw.k}=${value}`)
    if (parsed.kind !== 'entry') throw new Error('Version 0 record contains an invalid raw value.')
    value = parsed.effectiveValue
  }
  return {
    version,
    f: path.resolve(raw.f),
    k: raw.k,
    t: timestamp,
    op,
    v: value,
    order,
  }
}

function readEncryptedStoreLines(
  config: VaultConfig,
  options: { allowMissing?: boolean } = {},
): string[] {
  if (!existsSync(config.storePath)) {
    if (options.allowMissing) return []
    throw new EnvLaneError(
      'VAULT_STORE_NOT_FOUND',
      `Store file does not exist: ${config.storePath}`,
    )
  }
  return readFileSync(config.storePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function readStoreRecordLines(
  config: VaultConfig,
  key: Buffer,
  options: { allowMissing?: boolean; ignoreCorruptRecords?: boolean } = {},
): StoreRecordsReadResult {
  const lines = readEncryptedStoreLines(config, { allowMissing: options.allowMissing })
  const records: StoreRecordLine[] = []
  let failedRecords = 0
  let parsedRecords = 0
  let aliasedRecords = 0
  lines.forEach((line, order) => {
    try {
      const parsedRecord = validateStoreRecord(JSON.parse(decryptRecord(key, line)), order)
      const remapped = remapManagedStoreFilePath(parsedRecord.f, config)
      if (remapped.aliased) aliasedRecords++
      records.push({
        encryptedLine: line,
        lineIndex: order,
        record: parsedRecord,
        groupFilePath: remapped.filePath,
      })
      parsedRecords++
    } catch {
      failedRecords++
    }
  })
  if (lines.length > 0 && parsedRecords === 0) {
    throw new EnvLaneError(
      'VAULT_NO_READABLE_RECORDS',
      `No readable vault records found in ${config.storePath}. Check the key file.`,
    )
  }
  if (failedRecords > 0 && !options.ignoreCorruptRecords) {
    throw new EnvLaneError(
      'VAULT_CORRUPT_STORE',
      `Vault store contains ${failedRecords} unreadable record(s) in ${config.storePath}. Refusing to continue from partial state; pass ignoreCorruptRecords only after inspecting the store.`,
    )
  }
  return {
    records,
    failedRecords,
    parsedRecords,
    rawRecords: lines.length,
    aliasedRecords,
    rawLines: lines,
  }
}

function readStore(
  config: VaultConfig,
  key: Buffer,
  options: { allowMissing?: boolean; ignoreCorruptRecords?: boolean } = {},
): StoreReadResult {
  const state = new Map<string, Map<string, VaultRecord>>()
  const store = readStoreRecordLines(config, key, options)
  for (const item of store.records) {
    const record =
      item.groupFilePath === item.record.f ? item.record : { ...item.record, f: item.groupFilePath }
    const perFile = state.get(record.f) ?? new Map<string, VaultRecord>()
    const existing = perFile.get(record.k)
    if (!existing || isNewerRecord(record, existing)) perFile.set(record.k, record)
    state.set(record.f, perFile)
  }
  return { ...store, state }
}

function serializeRecord(key: Buffer, record: VaultRecord): string {
  const { version, f, k, t, op, v } = record
  return encryptRecord(key, JSON.stringify({ version, f, k, t, op, v }))
}

async function appendRecordsAtomically(
  config: VaultConfig,
  key: Buffer,
  records: VaultRecord[],
): Promise<void> {
  if (records.length === 0) return
  await withFileLock(config.storePath, () => {
    const existing = existsSync(config.storePath) ? readFileSync(config.storePath, 'utf8') : ''
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`
    writeFileContentAtomically(
      config.storePath,
      `${prefix}${records.map((record) => serializeRecord(key, record)).join('\n')}\n`,
    )
  })
}

async function rewriteStoreAtomically(
  config: VaultConfig,
  expectedLines: readonly string[],
  nextLines: readonly string[],
): Promise<void> {
  const expectedDigest = stableHash(expectedLines.join('\n'))
  await withFileLock(config.storePath, () => {
    const currentLines = readEncryptedStoreLines(config)
    if (stableHash(currentLines.join('\n')) !== expectedDigest) {
      throw new EnvLaneError(
        'VAULT_STORE_CHANGED',
        'The Vault store changed while preparing the rewrite. Retry the operation.',
        { storePath: config.storePath },
      )
    }
    writeFileContentAtomically(
      config.storePath,
      nextLines.length > 0 ? `${nextLines.join('\n')}\n` : '',
    )
  })
}

function withVaultOperationLock<T>(config: VaultConfig, operation: () => Promise<T>): Promise<T> {
  return withFileLock(`${config.storePath}.operation`, operation)
}

function excludedHistoricalRecords(config: VaultConfig, records: StoreRecordLine[]) {
  return records.filter((item) => isExcluded(config, item.groupFilePath, item.record.k))
}

function assertNoExcludedHistory(
  config: VaultConfig,
  records: StoreRecordLine[],
  failedRecords: number,
): void {
  if (config.exclude.length > 0 && failedRecords > 0) {
    throw new EnvLaneError(
      'VAULT_EXCLUDE_AUDIT_FAILED',
      `Cannot verify the local-only exclude boundary because ${failedRecords} vault record(s) are unreadable. Sanitize or repair the store before continuing; ignoreCorruptRecords cannot bypass exclude auditing.`,
    )
  }
  const excluded = excludedHistoricalRecords(config, records)
  if (excluded.length === 0) return
  const examples = [
    ...new Set(
      excluded.map(
        (item) => `${portable(path.relative(config.baseDir, item.groupFilePath))}:${item.record.k}`,
      ),
    ),
  ].slice(0, 3)
  throw new EnvLaneError(
    'VAULT_EXCLUDED_HISTORY',
    `Vault store contains ${excluded.length} historical record(s) now matched by exclude (${examples.join(', ')}). Excluded values are local-only; run "env-lane vault sanitize <keyFile> --excluded --dry-run" and then repeat with --yes before continuing. Rotate any secret that may already have been shared.`,
  )
}

function desiredRecordsForFile(
  config: VaultConfig,
  filePath: string,
  state: Map<string, Map<string, VaultRecord>>,
) {
  const desired = new Map<string, VaultRecord>()
  for (const record of state.get(filePath)?.values() ?? []) {
    if (isExcluded(config, filePath, record.k)) continue
    desired.set(record.k, record)
  }
  return desired
}

function redactedPreview(present: boolean): string {
  return present ? '<redacted>' : '<missing>'
}

function publicRestorePlan(plan: InternalRestorePlan): RestorePlan {
  return {
    ...plan,
    files: plan.files.map((file) => ({
      ...file,
      entries: file.entries.map(
        ({ currentValues: _currentValues, nextValue: _nextValue, ...entry }) => entry,
      ),
    })),
  }
}

function buildRestorePlanFromState(
  config: VaultConfig,
  store: StoreReadResult,
  vaultKey: Buffer,
  syncContext?: SyncContext,
): InternalRestorePlan {
  const files: InternalRestorePlanFile[] = []
  const summary: RestorePlan['summary'] = {
    add: 0,
    modify: 0,
    delete: 0,
    identical: 0,
    conflict: 0,
    filesWithChanges: 0,
  }
  const managedFiles = new Set(config.envFiles)
  const unmanagedStoreFiles = [...store.state.keys()].filter(
    (filePath) => !managedFiles.has(filePath),
  )
  const targetFiles = config.allowUnmanaged
    ? [...new Set([...config.envFiles, ...unmanagedStoreFiles])]
    : config.envFiles

  for (const filePath of targetFiles) {
    const desired = desiredRecordsForFile(config, filePath, store.state)
    const envDoc = loadEnvDocument(filePath)
    const entries: InternalRestorePlanEntry[] = []
    for (const record of desired.values()) {
      const occurrences = envDoc.occurrencesMap.get(record.k) ?? []
      const currentValues = occurrences.map((item) => item.effectiveValue)
      let vaultAction: Exclude<RestoreAction, 'conflict'>
      if (record.op === 'delete') vaultAction = occurrences.length === 0 ? 'identical' : 'delete'
      else if (occurrences.length === 0) vaultAction = 'add'
      else vaultAction = currentValues.every((value) => value === record.v) ? 'identical' : 'modify'
      const conflict =
        vaultAction === 'identical'
          ? { conflict: false }
          : restoreConflictCheck(config, syncContext, filePath, record.k, envDoc, record)
      const action: RestoreAction = conflict.conflict ? 'conflict' : vaultAction
      summary[action]++
      const entryId = keyedDigest(
        vaultKey,
        JSON.stringify({
          filePath: portable(path.relative(config.baseDir, filePath)),
          key: record.k,
          action,
          vaultAction,
          timestamp: record.t,
          record: recordValueFingerprint(vaultKey, record),
          local: keyedDigest(vaultKey, JSON.stringify(currentValues)),
        }),
      )
      entries.push({
        entryId,
        filePath,
        key: record.k,
        action,
        currentValues,
        occurrenceCount: occurrences.length,
        nextValue: record.op === 'set' ? record.v : undefined,
        conflict: conflict.conflict,
        vaultAction,
        conflictReason: conflict.reason,
        preview: {
          current: redactedPreview(occurrences.length > 0),
          vault: record.op === 'delete' ? '<delete>' : '<redacted>',
        },
      })
    }
    entries.sort((left, right) => left.key.localeCompare(right.key))
    const changed = entries.some((entry) => entry.action !== 'identical')
    if (changed) summary.filesWithChanges++
    files.push({ filePath, entries, changed })
  }

  const storeDigest = stableHash(store.records.map((item) => item.encryptedLine).join('\n'))
  const planDigest = keyedDigest(
    vaultKey,
    JSON.stringify({
      storeDigest,
      files: files.map((file) => file.entries.map((entry) => entry.entryId)),
      unmanagedStoreFiles,
    }),
  )
  return {
    version: 1,
    createdAt: Date.now(),
    planDigest,
    storeDigest,
    storePath: config.storePath,
    files,
    summary,
    failedRecords: store.failedRecords,
    parsedRecords: store.parsedRecords,
    rawRecords: store.rawRecords,
    aliasedRecords: store.aliasedRecords,
    unmanagedStoreFiles,
  }
}

async function resolveConflict(
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

function applyRestoreFile(
  config: VaultConfig,
  filePath: string,
  state: Map<string, Map<string, VaultRecord>>,
  selectedEntryIds: Set<string>,
  entries: InternalRestorePlanEntry[],
): boolean {
  const desired = desiredRecordsForFile(config, filePath, state)
  const selectedKeys = new Set(
    entries.filter((entry) => selectedEntryIds.has(entry.entryId)).map((entry) => entry.key),
  )
  return applyEnvDocumentPatches(
    filePath,
    [...desired.entries()]
      .filter(([key]) => selectedKeys.has(key))
      .map(([key, record]) =>
        record.op === 'set'
          ? { op: 'set' as const, key, value: record.v ?? '' }
          : { op: 'delete' as const, key },
      ),
    {
      update: 'all',
      matchCommented: false,
      sortAdditions: true,
    },
  ).changed
}

interface EncryptOptions {
  cwd?: string
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

async function encryptEnvFilesLocked(config: VaultConfig, key: Buffer, options: EncryptOptions) {
  const syncContext = loadSyncContext(
    options.syncDir ? path.resolve(options.cwd ?? config.baseDir, options.syncDir) : undefined,
    key,
  )
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
  await appendRecordsAtomically(config, key, accumulator.pendingRecords)
  if (syncContext) await saveSyncContext(syncContext)
  return {
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
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  const key = deriveVaultKey(path.resolve(options.cwd ?? process.cwd(), keyFilePath))
  return withVaultOperationLock(config, () => encryptEnvFilesLocked(config, key, options))
}

interface BuildRestorePlanOptions {
  cwd?: string
  ignoreCorruptRecords?: boolean
  syncDir?: string
  vaultConfigFile?: string
  autoRemapPaths?: boolean
  allowUnmanaged?: boolean
  resolvedConfig?: VaultConfig
}

function buildRestorePlanLocked(
  config: VaultConfig,
  key: Buffer,
  options: BuildRestorePlanOptions,
): RestorePlan {
  const syncContext = loadSyncContext(
    options.syncDir ? path.resolve(options.cwd ?? config.baseDir, options.syncDir) : undefined,
    key,
  )
  scrubExcludedSyncEntries(config, syncContext)
  const store = readStore(config, key, { ignoreCorruptRecords: options.ignoreCorruptRecords })
  assertNoExcludedHistory(config, store.records, store.failedRecords)
  return publicRestorePlan(buildRestorePlanFromState(config, store, key, syncContext))
}

export async function buildRestorePlan(
  configPath: string | undefined,
  keyFilePath: string,
  options: BuildRestorePlanOptions = {},
) {
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  const key = deriveVaultKey(path.resolve(options.cwd ?? process.cwd(), keyFilePath))
  return withVaultOperationLock(config, async () => buildRestorePlanLocked(config, key, options))
}

export async function decryptEnvFiles(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    cwd?: string
    dryRun?: boolean
    autoApprove?: boolean
    ignoreCorruptRecords?: boolean
    syncDir?: string
    conflictStrategy?: VaultConflictStrategy
    vaultConfigFile?: string
    autoRemapPaths?: boolean
    allowUnmanaged?: boolean
    resolvedConfig?: VaultConfig
    approveDeletes?: boolean
    decisions?: RestoreDecision[]
    selectEntry?: (entry: RestorePlanEntry) => boolean
    resolveConflict?: (
      entry: RestorePlanEntry,
    ) => Promise<'keep-local' | 'take-vault'> | 'keep-local' | 'take-vault'
  } = {},
) {
  const plan = await buildRestorePlan(configPath, keyFilePath, options)
  if (options.dryRun) return { ...plan, applied: false, filesWritten: 0, results: [] }
  return applyRestorePlan(configPath, keyFilePath, plan, options)
}

function decisionMap(decisions: RestoreDecision[] | undefined): Map<string, RestoreDecisionChoice> {
  const result = new Map<string, RestoreDecisionChoice>()
  for (const item of decisions ?? []) {
    if (!item || typeof item.entryId !== 'string') {
      throw new EnvLaneError('VAULT_INVALID_DECISION', 'Every decision requires an entryId.')
    }
    if (
      item.decision !== 'apply-vault' &&
      item.decision !== 'keep-local' &&
      item.decision !== 'skip'
    ) {
      throw new EnvLaneError(
        'VAULT_INVALID_DECISION',
        `Invalid decision for ${item.entryId}: ${String(item.decision)}`,
      )
    }
    result.set(item.entryId, item.decision)
  }
  if (decisions && result.size !== decisions.length) {
    throw new EnvLaneError('VAULT_INVALID_DECISION', 'Decision entryIds must be unique.')
  }
  return result
}

async function chooseRestoreEntries(
  plan: InternalRestorePlan,
  options: {
    decisions?: RestoreDecision[]
    approveDeletes?: boolean
    conflictStrategy?: VaultConflictStrategy
    selectEntry?: (entry: RestorePlanEntry) => boolean
    resolveConflict?: (
      entry: RestorePlanEntry,
    ) => Promise<'keep-local' | 'take-vault'> | 'keep-local' | 'take-vault'
  },
): Promise<{ selected: Set<string>; resolved: RestoreDecision[] }> {
  const supplied = decisionMap(options.decisions)
  const knownIds = new Set(plan.files.flatMap((file) => file.entries.map((entry) => entry.entryId)))
  for (const entryId of supplied.keys()) {
    if (!knownIds.has(entryId)) {
      throw new EnvLaneError(
        'VAULT_UNKNOWN_ENTRY_ID',
        `Decision references an entry that is not in the current plan: ${entryId}`,
      )
    }
  }
  if (options.decisions) {
    const requiredIds = new Set(
      plan.files.flatMap((file) =>
        file.entries.filter((entry) => entry.action !== 'identical').map((entry) => entry.entryId),
      ),
    )
    const missingIds = [...requiredIds].filter((entryId) => !supplied.has(entryId))
    if (missingIds.length > 0) {
      throw new EnvLaneError(
        'VAULT_MISSING_DECISIONS',
        'Explicit decisions must cover every non-identical entry in the current plan.',
        { missingEntryIds: missingIds },
      )
    }
  }

  const selected = new Set<string>()
  const resolved: RestoreDecision[] = []
  for (const entry of plan.files.flatMap((file) => file.entries)) {
    if (entry.action === 'identical') continue
    let decision = supplied.get(entry.entryId)
    if (!decision && options.selectEntry && !options.selectEntry(entry)) decision = 'skip'
    if (!decision && entry.action === 'delete' && !options.approveDeletes) decision = 'skip'
    if (!decision && entry.action === 'conflict') {
      const conflictDecision = await resolveConflict(
        options.conflictStrategy,
        entry,
        options.resolveConflict,
      )
      decision = conflictDecision === 'take-vault' ? 'apply-vault' : 'keep-local'
    }
    decision ??= 'apply-vault'
    if (decision === 'apply-vault') selected.add(entry.entryId)
    resolved.push({ entryId: entry.entryId, decision })
  }
  return { selected, resolved }
}

function assertFreshRestorePlan(submitted: RestorePlan, current: InternalRestorePlan): void {
  const submittedEntryIds = submitted.files.flatMap((file) =>
    file.entries.map((entry) => entry.entryId),
  )
  const currentEntryIds = current.files.flatMap((file) =>
    file.entries.map((entry) => entry.entryId),
  )
  const submittedEntrySet = new Set(submittedEntryIds)
  const currentEntrySet = new Set(currentEntryIds)
  const entrySetsMatch =
    submittedEntrySet.size === submittedEntryIds.length &&
    currentEntrySet.size === currentEntryIds.length &&
    submittedEntrySet.size === currentEntrySet.size &&
    [...submittedEntrySet].every((entryId) => currentEntrySet.has(entryId))
  if (
    submitted.version !== 1 ||
    submitted.storePath !== current.storePath ||
    submitted.planDigest !== current.planDigest ||
    !entrySetsMatch
  ) {
    throw new EnvLaneError(
      'VAULT_PLAN_STALE',
      'The Vault plan is stale or belongs to different inputs. Generate a new plan before applying.',
      {
        submittedPlanDigest: submitted.planDigest,
        currentPlanDigest: current.planDigest,
        submittedEntryIds,
        currentEntryIds,
      },
    )
  }
}

interface ApplyRestoreOptions {
  cwd?: string
  autoApprove?: boolean
  ignoreCorruptRecords?: boolean
  syncDir?: string
  conflictStrategy?: VaultConflictStrategy
  vaultConfigFile?: string
  autoRemapPaths?: boolean
  allowUnmanaged?: boolean
  resolvedConfig?: VaultConfig
  approveDeletes?: boolean
  decisions?: RestoreDecision[]
  selectEntry?: (entry: RestorePlanEntry) => boolean
  resolveConflict?: (
    entry: RestorePlanEntry,
  ) => Promise<'keep-local' | 'take-vault'> | 'keep-local' | 'take-vault'
}

async function applyRestorePlanLocked(
  config: VaultConfig,
  key: Buffer,
  submittedPlan: RestorePlan,
  options: ApplyRestoreOptions,
) {
  const syncContext = loadSyncContext(
    options.syncDir ? path.resolve(options.cwd ?? config.baseDir, options.syncDir) : undefined,
    key,
  )
  scrubExcludedSyncEntries(config, syncContext)
  const store = readStore(config, key, { ignoreCorruptRecords: options.ignoreCorruptRecords })
  assertNoExcludedHistory(config, store.records, store.failedRecords)
  const plan = buildRestorePlanFromState(config, store, key, syncContext)
  assertFreshRestorePlan(submittedPlan, plan)
  const { selected, resolved } = await chooseRestoreEntries(plan, options)
  if (selected.size > 0 && !options.autoApprove) {
    throw new EnvLaneError(
      'VAULT_CONFIRMATION_REQUIRED',
      'Applying the Vault plan requires explicit approval.',
      { hint: 'Pass autoApprove: true in the API or --yes in the CLI.' },
    )
  }
  const results: Array<{
    filePath: string
    keys: number
    changed: boolean
    entries: RestorePlanEntry[]
  }> = []
  let filesWritten = 0
  for (const file of plan.files) {
    const fileHasEffectiveChanges = file.entries.some((entry) => selected.has(entry.entryId))
    if (!fileHasEffectiveChanges) {
      results.push({
        filePath: file.filePath,
        keys: file.entries.filter((entry) => entry.action !== 'delete').length,
        changed: false,
        entries: publicRestorePlan({ ...plan, files: [file] }).files[0].entries,
      })
      continue
    }
    const changed = applyRestoreFile(config, file.filePath, store.state, selected, file.entries)
    if (changed) {
      filesWritten++
    }
    results.push({
      filePath: file.filePath,
      keys: file.entries.filter((entry) => entry.action !== 'delete').length,
      changed,
      entries: publicRestorePlan({ ...plan, files: [file] }).files[0].entries,
    })
  }
  if (syncContext) {
    for (const file of plan.files) {
      for (const entry of file.entries) {
        if (entry.action === 'identical' || selected.has(entry.entryId)) {
          const record = store.state.get(file.filePath)?.get(entry.key)
          if (record) updateSyncEntry(config, syncContext, record)
        }
      }
    }
    await saveSyncContext(syncContext)
  }
  const conflictEntries = new Set(
    plan.files.flatMap((file) =>
      file.entries.filter((entry) => entry.action === 'conflict').map((entry) => entry.entryId),
    ),
  )
  const conflictsKeptLocal = resolved.filter(
    (item) => item.decision === 'keep-local' && conflictEntries.has(item.entryId),
  ).length
  const conflictsTookVault = resolved.filter(
    (item) => item.decision === 'apply-vault' && conflictEntries.has(item.entryId),
  ).length
  const publicPlan = publicRestorePlan(plan)
  return {
    ...publicPlan,
    applied: filesWritten > 0,
    filesWritten,
    results,
    decisions: resolved,
    appliedEntries: selected.size,
    skippedEntries: resolved.length - selected.size,
    conflictsKeptLocal,
    conflictsTookVault,
    syncStatePath: syncContext?.statePath,
    syncStateMigratedFromVersion0: syncContext?.migratedFromVersion0 ?? false,
  }
}

export async function applyRestorePlan(
  configPath: string | undefined,
  keyFilePath: string,
  submittedPlan: RestorePlan,
  options: ApplyRestoreOptions = {},
) {
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  const key = deriveVaultKey(path.resolve(options.cwd ?? process.cwd(), keyFilePath))
  return withVaultOperationLock(config, () =>
    applyRestorePlanLocked(config, key, submittedPlan, options),
  )
}

async function confirmStoreRewrite(
  operation: 'history prune' | 'sanitize',
  options: { autoApprove?: boolean; dryRun?: boolean } = {},
): Promise<boolean> {
  if (options.dryRun) return false
  if (options.autoApprove) return true
  throw new EnvLaneError(
    'VAULT_CONFIRMATION_REQUIRED',
    `Vault ${operation} requires explicit approval.`,
    { hint: 'Pass autoApprove: true in the API or --yes in the CLI.' },
  )
}

function pruneGroupKey(record: StoreRecordLine): string {
  return `${record.groupFilePath}\0${record.record.k}`
}

function shouldPruneCandidate(
  candidate: PruneCandidate,
  rank: number,
  options: { keepRecent?: number; olderThanMs?: number; preserveLatest: boolean },
): boolean {
  if (options.preserveLatest && rank === 0) return false
  if (options.keepRecent !== undefined && rank >= options.keepRecent) return true
  if (options.olderThanMs !== undefined && candidate.record.t < options.olderThanMs) return true
  return false
}

export async function pruneVaultHistory(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    cwd?: string
    filePath?: string
    key?: string
    keepRecent?: number
    olderThanDays?: number
    preserveLatest?: boolean
    dryRun?: boolean
    autoApprove?: boolean
    ignoreCorruptRecords?: boolean
    vaultConfigFile?: string
    resolvedConfig?: VaultConfig
    expectedStoreDigest?: string
  } = {},
) {
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
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  const key = deriveVaultKey(path.resolve(options.cwd ?? process.cwd(), keyFilePath))
  return withVaultOperationLock(config, async () => {
    const store = readStoreRecordLines(config, key, {
      ignoreCorruptRecords: options.ignoreCorruptRecords,
    })
    const storeDigest = stableHash(store.rawLines.join('\n'))
    if (options.expectedStoreDigest && options.expectedStoreDigest !== storeDigest) {
      throw new EnvLaneError(
        'VAULT_STORE_CHANGED',
        'The Vault store changed after the prune preview. Preview the operation again.',
      )
    }
    const targetFilePath = options.filePath
      ? path.resolve(config.baseDir, options.filePath)
      : undefined
    const groups = new Map<string, PruneCandidate[]>()
    store.records.forEach((record) => {
      if (targetFilePath && record.groupFilePath !== targetFilePath) return
      if (options.key && record.record.k !== options.key) return
      const group = groups.get(pruneGroupKey(record)) ?? []
      group.push({ index: record.lineIndex, record: record.record })
      groups.set(pruneGroupKey(record), group)
    })

    const keep = new Set(store.rawLines.map((_, index) => index))
    const olderThanMs =
      options.olderThanDays === undefined
        ? undefined
        : Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
    const preserveLatest = options.preserveLatest ?? true
    for (const group of groups.values()) {
      const sorted = [...group].sort((left, right) => {
        if (isNewerRecord(left.record, right.record)) return -1
        if (isNewerRecord(right.record, left.record)) return 1
        return 0
      })
      sorted.forEach((candidate, rank) => {
        if (
          shouldPruneCandidate(candidate, rank, {
            keepRecent: options.keepRecent,
            olderThanMs,
            preserveLatest,
          })
        ) {
          keep.delete(candidate.index)
        }
      })
    }

    const keptLines = store.rawLines.filter((_, index) => keep.has(index))
    const removedRecords = store.rawLines.length - keptLines.length
    const result = {
      storePath: config.storePath,
      storeDigest,
      rawRecords: store.rawRecords,
      parsedRecords: store.parsedRecords,
      failedRecords: store.failedRecords,
      aliasedRecords: store.aliasedRecords,
      groups: groups.size,
      removedRecords,
      keptRecords: keptLines.length,
      applied: false,
    }
    if (removedRecords === 0 || options.dryRun) return result
    const confirmed = await confirmStoreRewrite('history prune', options)
    if (!confirmed) return result
    await rewriteStoreAtomically(config, store.rawLines, keptLines)
    return { ...result, applied: true }
  })
}

export async function sanitizeVaultHistory(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    cwd?: string
    excluded?: boolean
    dryRun?: boolean
    autoApprove?: boolean
    vaultConfigFile?: string
    resolvedConfig?: VaultConfig
    expectedStoreDigest?: string
  } = {},
) {
  if (!options.excluded) {
    throw new EnvLaneError(
      'VAULT_SANITIZE_SCOPE_REQUIRED',
      'Vault sanitize requires --excluded so the removal scope is explicit.',
    )
  }
  const config = options.resolvedConfig ?? (await loadVaultConfig(configPath, options))
  const key = deriveVaultKey(path.resolve(options.cwd ?? process.cwd(), keyFilePath))
  return withVaultOperationLock(config, async () => {
    const store = readStoreRecordLines(config, key)
    const storeDigest = stableHash(store.rawLines.join('\n'))
    if (options.expectedStoreDigest && options.expectedStoreDigest !== storeDigest) {
      throw new EnvLaneError(
        'VAULT_STORE_CHANGED',
        'The Vault store changed after the sanitize preview. Preview the operation again.',
      )
    }
    const removed = excludedHistoricalRecords(config, store.records)
    const removedLineIndexes = new Set(removed.map((record) => record.lineIndex))
    const keptLines = store.rawLines.filter((_, index) => !removedLineIndexes.has(index))
    const affectedEntries = [
      ...new Set(
        removed.map(
          (item) =>
            `${portable(path.relative(config.baseDir, item.groupFilePath))}:${item.record.k}`,
        ),
      ),
    ].sort()
    const result = {
      storePath: config.storePath,
      storeDigest,
      removedRecords: removed.length,
      keptRecords: keptLines.length,
      affectedEntries,
      applied: false,
    }
    if (removed.length === 0 || options.dryRun) return result
    const confirmed = await confirmStoreRewrite('sanitize', options)
    if (!confirmed) return result
    await rewriteStoreAtomically(config, store.rawLines, keptLines)
    return { ...result, applied: true }
  })
}
