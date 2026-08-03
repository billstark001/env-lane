/// <reference path="./picomatch.d.ts" />

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  applyEnvDocumentPatches,
  getLogger,
  type LoadedEnvDocument,
  loadEnvDocument,
  parseEnvLine,
  writeFileContentAtomically,
} from '@env-lane/core'
import picomatch from 'picomatch'
import { loadVaultConfig, type VaultConfig } from './config.js'
import { decryptRecord, deriveVaultKey, deriveVaultSyncKey, encryptRecord } from './crypto.js'
import { warnUnsafeVault } from './warning.js'

export type VaultOperation = 'set' | 'delete'
export type RestoreAction = 'add' | 'modify' | 'delete' | 'identical' | 'conflict'
export type VaultConflictStrategy = 'ask' | 'abort' | 'keep-local' | 'take-vault'

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
  filePath: string
  key: string
  action: RestoreAction
  currentValues: string[]
  occurrenceCount: number
  nextValue?: string
  conflict?: boolean
  vaultAction?: Exclude<RestoreAction, 'conflict'>
  conflictReason?: string
}

export interface RestorePlanFile {
  filePath: string
  entries: RestorePlanEntry[]
  changed: boolean
}

export interface RestorePlan {
  storePath: string
  files: RestorePlanFile[]
  summary: Record<RestoreAction, number> & { filesWithChanges: number }
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
  unmanagedStoreFiles: string[]
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
  record: VaultRecord
  groupFilePath: string
}

interface StoreRecordsReadResult {
  records: StoreRecordLine[]
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
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

const PREVIEW_VALUE_LIMIT = 160
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
      syncKey,
      migratedFromVersion0: false,
    }
  const parsed = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid vault sync state file: ${statePath}`)
  }
  const raw = parsed as Record<string, unknown>
  if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
    throw new Error(`Unsupported vault sync state file: ${statePath}`)
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
      syncKey,
      migratedFromVersion0: true,
    }
  }
  if (raw.version !== 1 || raw.fingerprint !== 'hmac-sha256') {
    throw new Error(`Unsupported vault sync state file: ${statePath}`)
  }
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).valueFingerprint !== 'string'
    ) {
      throw new Error(`Invalid vault sync state entry: ${statePath}`)
    }
  }
  return {
    syncDir: resolvedSyncDir,
    statePath,
    state: raw as unknown as SyncState,
    syncKey,
    migratedFromVersion0: false,
  }
}

function saveSyncContext(context: SyncContext): void {
  writeFileContentAtomically(context.statePath, `${JSON.stringify(context.state, null, 2)}\n`)
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

function emitStructuredChange(
  command: 'encrypt' | 'decrypt' | 'sort',
  payload: Record<string, string | number | boolean | undefined>,
): void {
  getLogger().info(`[env-lane:vault] ${JSON.stringify({ command, ...payload })}`)
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
    throw new Error(`Store file does not exist: ${config.storePath}`)
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
        record: parsedRecord,
        groupFilePath: remapped.filePath,
      })
      parsedRecords++
    } catch {
      failedRecords++
    }
  })
  if (lines.length > 0 && parsedRecords === 0) {
    throw new Error(`No readable vault records found in ${config.storePath}. Check the key file.`)
  }
  if (failedRecords > 0 && !options.ignoreCorruptRecords) {
    throw new Error(
      `Vault store contains ${failedRecords} unreadable record(s) in ${config.storePath}. Refusing to continue from partial state; pass ignoreCorruptRecords only after inspecting the store.`,
    )
  }
  return { records, failedRecords, parsedRecords, rawRecords: lines.length, aliasedRecords }
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

function appendRecordsAtomically(config: VaultConfig, key: Buffer, records: VaultRecord[]): void {
  if (records.length === 0) return
  const existing = existsSync(config.storePath) ? readFileSync(config.storePath, 'utf8') : ''
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`
  writeFileContentAtomically(
    config.storePath,
    `${prefix}${records.map((record) => serializeRecord(key, record)).join('\n')}\n`,
  )
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
    throw new Error(
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
  throw new Error(
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

function formatPreviewValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
  const quoted = `"${escaped}"`
  if (quoted.length <= PREVIEW_VALUE_LIMIT) return quoted
  return `"${escaped.slice(0, PREVIEW_VALUE_LIMIT - 24)}"... (${value.length} chars)`
}

function formatPreviewValues(values: string[], occurrenceCount: number): string {
  const uniqueValues = [...new Set(values)]
  const valuePreview =
    uniqueValues.length === 1
      ? formatPreviewValue(uniqueValues[0])
      : `[${uniqueValues.map(formatPreviewValue).join(', ')}]`
  return occurrenceCount > 1 ? `${valuePreview} (${occurrenceCount} occurrences)` : valuePreview
}

function buildRestorePlanFromState(
  config: VaultConfig,
  store: StoreReadResult,
  syncContext?: SyncContext,
): RestorePlan {
  const files: RestorePlanFile[] = []
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
    const entries: RestorePlanEntry[] = []
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
      entries.push({
        filePath,
        key: record.k,
        action,
        currentValues,
        occurrenceCount: occurrences.length,
        nextValue: record.op === 'set' ? record.v : undefined,
        conflict: conflict.conflict,
        vaultAction,
        conflictReason: conflict.reason,
      })
    }
    entries.sort((left, right) => left.key.localeCompare(right.key))
    const changed = entries.some((entry) => entry.action !== 'identical')
    if (changed) summary.filesWithChanges++
    files.push({ filePath, entries, changed })
  }

  return {
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

function printRestorePreview(plan: RestorePlan): void {
  const logger = getLogger()
  logger.log('[env-lane:vault] Restore preview:')
  if (plan.summary.filesWithChanges === 0) {
    logger.log('[env-lane:vault] No file changes detected.')
    logger.log(`[env-lane:vault] Skipped identical key-value pairs: ${plan.summary.identical}`)
    return
  }

  for (const file of plan.files) {
    const changedEntries = file.entries.filter((entry) => entry.action !== 'identical')
    if (changedEntries.length === 0) continue
    logger.log(`\n[env-lane:vault] File: ${file.filePath}`)
    for (const entry of changedEntries) {
      if (entry.action === 'add') {
        logger.log(`  ADD ${entry.key}=${formatPreviewValue(entry.nextValue ?? '')}`)
      } else if (entry.action === 'modify') {
        logger.log(
          `  MODIFY ${entry.key}: ${formatPreviewValues(entry.currentValues, entry.occurrenceCount)} -> ${formatPreviewValue(entry.nextValue ?? '')}`,
        )
      } else if (entry.action === 'delete') {
        logger.log(
          `  DELETE ${entry.key}: ${formatPreviewValues(entry.currentValues, entry.occurrenceCount)}`,
        )
      } else {
        const target =
          entry.vaultAction === 'delete' ? '<delete>' : formatPreviewValue(entry.nextValue ?? '')
        logger.log(
          `  CONFLICT ${entry.key}: ${formatPreviewValues(entry.currentValues, entry.occurrenceCount)} -> ${target}${entry.conflictReason ? ` (${entry.conflictReason})` : ''}`,
        )
      }
    }
  }
  logger.log('')
  logger.log(
    `[env-lane:vault] Summary: ${plan.summary.modify} modify, ${plan.summary.add} add, ${plan.summary.delete} delete, ${plan.summary.conflict} conflict, ${plan.summary.identical} identical skipped`,
  )
}

async function readSingleKey(prompt: string, choices?: string[]): Promise<string> {
  const logger = getLogger()
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive terminal is required.')
  }
  logger.write(prompt)
  return new Promise((resolve) => {
    const stdin = process.stdin
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.pause()
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
    }
    const onData = (chunk: Buffer) => {
      const input = String(chunk)
      if (input === '\u0003') {
        cleanup()
        logger.write('\n')
        resolve('\u0003')
        return
      }
      const char = input
        .replace(/[\r\n]+/g, '')
        .trim()
        .toLowerCase()
      if (!choices || choices.includes(char)) {
        cleanup()
        logger.write('\n')
        resolve(char)
      }
    }
    stdin.resume()
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
    stdin.on('data', onData)
  })
}

async function confirmRestore(
  options: { autoApprove?: boolean; dryRun?: boolean } = {},
): Promise<boolean> {
  const logger = getLogger()
  if (options.dryRun) return false
  if (options.autoApprove) {
    logger.log('[env-lane:vault] Auto-approved restore.')
    return true
  }
  const key = await readSingleKey(
    '[env-lane:vault] Press y to apply restore, any other key to cancel: ',
  )
  return key === 'y'
}

async function promptChoice(prompt: string, choices: string[]): Promise<string> {
  const key = await readSingleKey(prompt, choices)
  return key
}

async function resolveConflict(
  strategy: VaultConflictStrategy | undefined,
  prompt: string,
): Promise<'keep-local' | 'take-vault'> {
  const effectiveStrategy = strategy ?? 'abort'
  if (effectiveStrategy === 'keep-local' || effectiveStrategy === 'take-vault') {
    return effectiveStrategy
  }
  if (effectiveStrategy === 'abort') {
    throw new Error(
      'Vault conflict resolution aborted. Re-run with --conflicts keep-local, take-vault, or ask.',
    )
  }
  const choice = await promptChoice(prompt, ['l', 'v'])
  if (choice === '\u0003') {
    throw new Error('Vault conflict resolution aborted by user.')
  }
  return choice === 'l' ? 'keep-local' : 'take-vault'
}

async function resolveRestoreConflicts(
  plan: RestorePlan,
  strategy: VaultConflictStrategy | undefined,
): Promise<Set<string>> {
  const ignored = new Set<string>()
  for (const file of plan.files) {
    for (const entry of file.entries.filter((item) => item.action === 'conflict')) {
      const decision = await resolveConflict(
        strategy,
        `[env-lane:vault] Conflict ${entry.filePath} ${entry.key}: keep local (l) or take vault (v)? `,
      )
      if (decision === 'keep-local') ignored.add(`${entry.filePath}\0${entry.key}`)
    }
  }
  return ignored
}

function applyRestoreFile(
  config: VaultConfig,
  filePath: string,
  state: Map<string, Map<string, VaultRecord>>,
  ignoredConflicts: Set<string> = new Set(),
): boolean {
  const desired = desiredRecordsForFile(config, filePath, state)
  const ignoredKeys = new Set(
    [...desired.keys()].filter((key) => ignoredConflicts.has(`${filePath}\0${key}`)),
  )
  return applyEnvDocumentPatches(
    filePath,
    [...desired.entries()].map(([key, record]) =>
      record.op === 'set'
        ? { op: 'set' as const, key, value: record.v ?? '' }
        : { op: 'delete' as const, key },
    ),
    {
      ignoredKeys,
      update: 'all',
      matchCommented: false,
      sortAdditions: true,
    },
  ).changed
}

export async function encryptEnvFiles(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    disableUnsafeWarning?: boolean
    ignoreCorruptRecords?: boolean
    syncDir?: string
    conflictStrategy?: VaultConflictStrategy
    vaultConfigFile?: string
    autoRemapPaths?: boolean
    allowUnmanaged?: boolean
  } = {},
) {
  const config = await loadVaultConfig(configPath, options)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const syncContext = loadSyncContext(options.syncDir, key)
  scrubExcludedSyncEntries(config, syncContext)
  const store = readStore(config, key, {
    allowMissing: true,
    ignoreCorruptRecords: options.ignoreCorruptRecords,
  })
  assertNoExcludedHistory(config, store.records, store.failedRecords)
  const state = store.state
  const pendingRecords: VaultRecord[] = []
  const pendingChanges: Array<Record<string, string | number | boolean | undefined>> = []
  let setRecordsWritten = 0
  let deleteRecordsWritten = 0
  let skippedUnchanged = 0
  let localOnlyEntriesSkipped = 0
  let missingFilesSkipped = 0
  let invalidLinesIgnored = 0
  let shadowedEntriesIgnored = 0
  let conflicts = 0
  let conflictsKeptLocal = 0
  let conflictsTookVault = 0

  for (const filePath of config.envFiles) {
    if (!existsSync(filePath)) {
      missingFilesSkipped++
      continue
    }
    const envDoc = loadEnvDocument(filePath)
    const prev = state.get(filePath) ?? new Map<string, VaultRecord>()
    const current = new Map<string, string>()
    for (const [keyName, { effectiveValue }] of envDoc.currentMap) {
      if (isExcluded(config, filePath, keyName)) {
        localOnlyEntriesSkipped++
        continue
      }
      current.set(keyName, effectiveValue)
      const old = prev.get(keyName)
      if (old?.op === 'set' && old.v === effectiveValue) {
        skippedUnchanged++
        updateSyncEntry(config, syncContext, old)
        continue
      }
      const conflict = pushConflictCheck(
        config,
        syncContext,
        filePath,
        keyName,
        syncContext ? valueFingerprint(syncContext.syncKey, 'set', effectiveValue) : '',
        old,
      )
      if (conflict.conflict) {
        conflicts++
        const decision = await resolveConflict(
          options.conflictStrategy,
          `[env-lane:vault] Conflict ${filePath} ${keyName}: keep local (l) or take vault (v)? `,
        )
        if (decision === 'take-vault') {
          conflictsTookVault++
          continue
        }
        conflictsKeptLocal++
      }
      const record = {
        version: 1 as const,
        f: filePath,
        k: keyName,
        v: effectiveValue,
        op: 'set' as const,
        t: Date.now(),
      }
      pendingRecords.push(record)
      updateSyncEntry(config, syncContext, record)
      pendingChanges.push({
        action: old?.op === 'set' ? 'update' : 'set',
        filePath: portable(filePath),
        key: keyName,
      })
      setRecordsWritten++
    }
    if (config.trackDeletions) {
      for (const [keyName, old] of prev.entries()) {
        if (isExcluded(config, filePath, keyName)) continue
        if (old.op === 'set' && !current.has(keyName)) {
          const conflict = pushConflictCheck(
            config,
            syncContext,
            filePath,
            keyName,
            syncContext ? valueFingerprint(syncContext.syncKey, 'delete') : '',
            old,
          )
          if (conflict.conflict) {
            conflicts++
            const decision = await resolveConflict(
              options.conflictStrategy,
              `[env-lane:vault] Conflict ${filePath} ${keyName}: keep local deletion (l) or take vault value (v)? `,
            )
            if (decision === 'take-vault') {
              conflictsTookVault++
              continue
            }
            conflictsKeptLocal++
          }
          const record = {
            version: 1 as const,
            f: filePath,
            k: keyName,
            op: 'delete' as const,
            t: Date.now(),
          }
          pendingRecords.push(record)
          updateSyncEntry(config, syncContext, record)
          pendingChanges.push({
            action: 'delete',
            filePath: portable(filePath),
            key: keyName,
          })
          deleteRecordsWritten++
        }
      }
    }
    for (const [keyName, old] of prev.entries()) {
      if (old.op === 'delete' && !current.has(keyName)) updateSyncEntry(config, syncContext, old)
    }
    invalidLinesIgnored += envDoc.invalidLineCount
    shadowedEntriesIgnored += envDoc.shadowedEntryCount
  }
  appendRecordsAtomically(config, key, pendingRecords)
  for (const change of pendingChanges) emitStructuredChange('encrypt', change)
  if (syncContext) saveSyncContext(syncContext)
  return {
    storePath: config.storePath,
    setRecordsWritten,
    deleteRecordsWritten,
    skippedUnchanged,
    localOnlyEntriesSkipped,
    missingFilesSkipped,
    invalidLinesIgnored,
    shadowedEntriesIgnored,
    rawRecords: store.rawRecords,
    parsedRecords: store.parsedRecords,
    failedRecords: store.failedRecords,
    aliasedRecords: store.aliasedRecords,
    conflicts,
    conflictsKeptLocal,
    conflictsTookVault,
    syncStatePath: syncContext?.statePath,
    syncStateMigratedFromVersion0: syncContext?.migratedFromVersion0 ?? false,
  }
}

export async function buildRestorePlan(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    disableUnsafeWarning?: boolean
    ignoreCorruptRecords?: boolean
    syncDir?: string
    vaultConfigFile?: string
    autoRemapPaths?: boolean
    allowUnmanaged?: boolean
  } = {},
) {
  const config = await loadVaultConfig(configPath, options)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const syncContext = loadSyncContext(options.syncDir, key)
  scrubExcludedSyncEntries(config, syncContext)
  const store = readStore(config, key, { ignoreCorruptRecords: options.ignoreCorruptRecords })
  assertNoExcludedHistory(config, store.records, store.failedRecords)
  return buildRestorePlanFromState(config, store, syncContext)
}

export async function decryptEnvFiles(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    dryRun?: boolean
    autoApprove?: boolean
    disableUnsafeWarning?: boolean
    ignoreCorruptRecords?: boolean
    syncDir?: string
    conflictStrategy?: VaultConflictStrategy
    vaultConfigFile?: string
    autoRemapPaths?: boolean
    allowUnmanaged?: boolean
  } = {},
) {
  const config = await loadVaultConfig(configPath, options)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const syncContext = loadSyncContext(options.syncDir, key)
  scrubExcludedSyncEntries(config, syncContext)
  const store = readStore(config, key, { ignoreCorruptRecords: options.ignoreCorruptRecords })
  assertNoExcludedHistory(config, store.records, store.failedRecords)
  const plan = buildRestorePlanFromState(config, store, syncContext)
  printRestorePreview(plan)
  const logger = getLogger()
  if (plan.failedRecords > 0) {
    logger.warn(
      `[env-lane:vault] Warning: skipped ${plan.failedRecords} unreadable store record(s).`,
    )
  }
  if (plan.aliasedRecords > 0) {
    logger.log(
      `[env-lane:vault] Remapped ${plan.aliasedRecords} store record(s) from previous checkout paths to current env files.`,
    )
  }
  if (!config.allowUnmanaged && plan.unmanagedStoreFiles.length > 0) {
    logger.warn(
      `[env-lane:vault] Warning: ignored ${plan.unmanagedStoreFiles.length} store file(s) not listed in config.envFiles.`,
    )
  }
  const ignoredConflicts =
    !options.dryRun && plan.summary.conflict > 0
      ? await resolveRestoreConflicts(plan, options.conflictStrategy)
      : new Set<string>()
  const results: Array<{
    filePath: string
    keys: number
    changed: boolean
    entries: RestorePlanEntry[]
  }> = []
  const effectiveChanges = plan.files.some((file) =>
    file.entries.some(
      (entry) =>
        entry.action !== 'identical' && !ignoredConflicts.has(`${file.filePath}\0${entry.key}`),
    ),
  )
  if (!effectiveChanges || options.dryRun) {
    if (!options.dryRun && syncContext) {
      for (const file of plan.files) {
        for (const entry of file.entries) {
          if (entry.action === 'identical' && entry.vaultAction) {
            const record = store.state.get(file.filePath)?.get(entry.key)
            if (record) updateSyncEntry(config, syncContext, record)
          }
        }
      }
      saveSyncContext(syncContext)
    }
    for (const file of plan.files) {
      results.push({
        filePath: file.filePath,
        keys: file.entries.filter((entry) => entry.action !== 'delete').length,
        changed: file.changed,
        entries: file.entries,
      })
    }
    return { ...plan, applied: false, filesWritten: 0, results }
  }

  const confirmed = await confirmRestore(options)
  if (!confirmed) {
    logger.log('[env-lane:vault] Restore cancelled. No files were changed.')
    for (const file of plan.files) {
      results.push({
        filePath: file.filePath,
        keys: file.entries.filter((entry) => entry.action !== 'delete').length,
        changed: file.changed,
        entries: file.entries,
      })
    }
    return { ...plan, applied: false, filesWritten: 0, results }
  }

  let filesWritten = 0
  for (const file of plan.files) {
    const fileHasEffectiveChanges = file.entries.some(
      (entry) =>
        entry.action !== 'identical' && !ignoredConflicts.has(`${file.filePath}\0${entry.key}`),
    )
    if (!file.changed || !fileHasEffectiveChanges) {
      results.push({
        filePath: file.filePath,
        keys: file.entries.filter((entry) => entry.action !== 'delete').length,
        changed: false,
        entries: file.entries,
      })
      continue
    }
    const changed = applyRestoreFile(config, file.filePath, store.state, ignoredConflicts)
    if (changed) {
      filesWritten++
      for (const entry of file.entries.filter((item) => item.action !== 'identical')) {
        if (ignoredConflicts.has(`${file.filePath}\0${entry.key}`)) continue
        const action = entry.action === 'conflict' ? entry.vaultAction : entry.action
        emitStructuredChange('decrypt', {
          action,
          filePath: portable(file.filePath),
          key: entry.key,
        })
      }
      emitStructuredChange('decrypt', { action: 'write-file', filePath: portable(file.filePath) })
    }
    results.push({
      filePath: file.filePath,
      keys: file.entries.filter((entry) => entry.action !== 'delete').length,
      changed,
      entries: file.entries,
    })
  }
  if (syncContext) {
    for (const file of plan.files) {
      for (const entry of file.entries) {
        if (ignoredConflicts.has(`${file.filePath}\0${entry.key}`)) continue
        if (entry.action === 'identical' || entry.action !== 'conflict' || entry.vaultAction) {
          const record = store.state.get(file.filePath)?.get(entry.key)
          if (record) updateSyncEntry(config, syncContext, record)
        }
      }
    }
    saveSyncContext(syncContext)
  }
  return {
    ...plan,
    applied: filesWritten > 0,
    filesWritten,
    results,
    conflictsKeptLocal: ignoredConflicts.size,
    conflictsTookVault: plan.summary.conflict - ignoredConflicts.size,
    syncStatePath: syncContext?.statePath,
    syncStateMigratedFromVersion0: syncContext?.migratedFromVersion0 ?? false,
  }
}

async function confirmStoreRewrite(
  operation: 'history prune' | 'sanitize',
  options: { autoApprove?: boolean; dryRun?: boolean } = {},
): Promise<boolean> {
  const logger = getLogger()
  if (options.dryRun) return false
  if (options.autoApprove) {
    logger.log(`[env-lane:vault] Auto-approved ${operation}.`)
    return true
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Vault ${operation} confirmation requires an interactive terminal. Re-run with --yes to apply or --dry-run to preview.`,
    )
  }
  const choice = await promptChoice('[env-lane:vault] Rewrite the vault store? y/n: ', ['y', 'n'])
  return choice === 'y'
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
    filePath?: string
    key?: string
    keepRecent?: number
    olderThanDays?: number
    preserveLatest?: boolean
    dryRun?: boolean
    autoApprove?: boolean
    disableUnsafeWarning?: boolean
    ignoreCorruptRecords?: boolean
    vaultConfigFile?: string
  } = {},
) {
  if (options.keepRecent === undefined && options.olderThanDays === undefined) {
    throw new Error('History prune requires --keep-recent or --older-than-days.')
  }
  if (
    options.keepRecent !== undefined &&
    (!Number.isInteger(options.keepRecent) || options.keepRecent < 1)
  ) {
    throw new Error('keepRecent must be a positive integer.')
  }
  if (
    options.olderThanDays !== undefined &&
    (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 0)
  ) {
    throw new Error('olderThanDays must be a non-negative number.')
  }
  const config = await loadVaultConfig(configPath, options)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const store = readStoreRecordLines(config, key, {
    ignoreCorruptRecords: options.ignoreCorruptRecords,
  })
  const targetFilePath = options.filePath
    ? path.resolve(config.baseDir, options.filePath)
    : undefined
  const groups = new Map<string, PruneCandidate[]>()
  store.records.forEach((record, index) => {
    if (targetFilePath && record.groupFilePath !== targetFilePath) return
    if (options.key && record.record.k !== options.key) return
    const group = groups.get(pruneGroupKey(record)) ?? []
    group.push({ index, record: record.record })
    groups.set(pruneGroupKey(record), group)
  })

  const keep = new Set(store.records.map((_, index) => index))
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

  const keptLines = store.records
    .filter((_, index) => keep.has(index))
    .map((record) => record.encryptedLine)
  const removedRecords = store.records.length - keptLines.length
  const result = {
    storePath: config.storePath,
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
  writeFileContentAtomically(
    config.storePath,
    keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '',
  )
  return { ...result, applied: true }
}

export async function sanitizeVaultHistory(
  configPath: string | undefined,
  keyFilePath: string,
  options: {
    excluded?: boolean
    dryRun?: boolean
    autoApprove?: boolean
    disableUnsafeWarning?: boolean
    vaultConfigFile?: string
  } = {},
) {
  if (!options.excluded) {
    throw new Error('Vault sanitize requires --excluded so the removal scope is explicit.')
  }
  const config = await loadVaultConfig(configPath, options)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const store = readStoreRecordLines(config, key)
  const removed = excludedHistoricalRecords(config, store.records)
  const removedSet = new Set(removed)
  const keptLines = store.records
    .filter((record) => !removedSet.has(record))
    .map((record) => record.encryptedLine)
  const affectedEntries = [
    ...new Set(
      removed.map(
        (item) => `${portable(path.relative(config.baseDir, item.groupFilePath))}:${item.record.k}`,
      ),
    ),
  ].sort()
  const result = {
    storePath: config.storePath,
    removedRecords: removed.length,
    keptRecords: keptLines.length,
    affectedEntries,
    applied: false,
  }
  if (removed.length === 0 || options.dryRun) return result
  const confirmed = await confirmStoreRewrite('sanitize', options)
  if (!confirmed) return result
  writeFileContentAtomically(
    config.storePath,
    keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '',
  )
  return { ...result, applied: true }
}

export async function runVault(
  configPath: string,
  keyFilePath: string,
  mode: 'encrypt' | 'decrypt',
  options: {
    dryRun?: boolean
    autoApprove?: boolean
    disableUnsafeWarning?: boolean
    ignoreCorruptRecords?: boolean
    syncDir?: string
    conflictStrategy?: VaultConflictStrategy
    vaultConfigFile?: string
  } = {},
) {
  return mode === 'encrypt'
    ? encryptEnvFiles(configPath, keyFilePath, options)
    : decryptEnvFiles(configPath, keyFilePath, options)
}
