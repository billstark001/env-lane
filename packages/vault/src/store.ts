import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import picomatch from 'picomatch'
import { loadVaultConfig, type VaultConfig } from './config.js'
import { decryptRecord, deriveVaultKey, encryptRecord } from './crypto.js'
import { warnUnsafeVault } from './warning.js'

export type VaultOperation = 'set' | 'delete'
export type RestoreAction = 'add' | 'modify' | 'delete' | 'identical'

export interface VaultRecord {
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
  excludedRecordsIgnored: number
}

interface StoreReadResult {
  state: Map<string, Map<string, VaultRecord>>
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
}

interface EnvDocument {
  hasBom: boolean
  eol: string
  hasFinalNewline: boolean
  lines: string[]
}

type ParsedEnvLine =
  | { kind: 'empty' | 'comment'; rawLine: string; lineNumber: number }
  | {
      kind: 'entry' | 'commented-entry'
      rawLine: string
      lineNumber: number
      key: string
      prefix: string
      rawValue: string
    }
  | { kind: 'invalid'; rawLine: string; lineNumber: number; reason: string }
type ParsedEnvLineData =
  | { kind: 'empty' | 'comment'; rawLine: string }
  | {
      kind: 'entry' | 'commented-entry'
      rawLine: string
      key: string
      prefix: string
      rawValue: string
    }
  | { kind: 'invalid'; rawLine: string; reason: string }

interface LoadedEnvDocument {
  exists: boolean
  document: EnvDocument
  parsedLines: ParsedEnvLine[]
  currentMap: Map<string, { value: string }>
  occurrencesMap: Map<string, Array<{ value: string; prefix: string; lineNumber: number }>>
  invalidLineCount: number
  shadowedEntryCount: number
}

const ENV_ENTRY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const COMMENTED_ENV_ENTRY_RE = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const PREVIEW_VALUE_LIMIT = 160

function portable(file: string): string {
  return file.replace(/\\/g, '/').replaceAll(path.sep, '/')
}

function emitStructuredChange(
  command: 'encrypt' | 'decrypt' | 'sort',
  payload: Record<string, string | number | boolean | undefined>,
): void {
  console.log(`[env-store-change] ${JSON.stringify({ command, ...payload })}`)
}

function isExcluded(config: VaultConfig, filePath: string, key: string): boolean {
  const rel = portable(path.relative(config.baseDir, filePath))
  for (const rule of config.exclude) {
    const fileMatch = picomatch(rule.files, { dot: true })
    const keyMatch = picomatch(rule.keys, { dot: true })
    if ((fileMatch(rel) || fileMatch(path.basename(filePath))) && keyMatch(key)) return true
  }
  return false
}

function isNewerRecord(candidate: VaultRecord, existing: VaultRecord): boolean {
  if (candidate.t !== existing.t) return candidate.t > existing.t
  return (candidate.order ?? 0) > (existing.order ?? 0)
}

function buildManagedFileAliases(config: VaultConfig) {
  return [...new Set(config.envFiles.map((filePath) => path.resolve(filePath)))].map(
    (filePath) => ({
      filePath,
      relativePath: portable(path.relative(config.baseDir, filePath)),
    }),
  )
}

function remapManagedStoreFilePath(
  filePath: string,
  config: VaultConfig,
): { filePath: string; aliased: boolean } {
  const resolvedFilePath = path.resolve(filePath)
  const aliases = buildManagedFileAliases(config)
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
  return {
    f: path.resolve(raw.f),
    k: raw.k,
    t: timestamp,
    op,
    v: op === 'set' ? (raw.v as string) : undefined,
    order,
  }
}

function readStore(
  config: VaultConfig,
  key: Buffer,
  options: { allowMissing?: boolean } = {},
): StoreReadResult {
  const state = new Map<string, Map<string, VaultRecord>>()
  if (!existsSync(config.storePath)) {
    if (options.allowMissing) {
      return { state, failedRecords: 0, parsedRecords: 0, rawRecords: 0, aliasedRecords: 0 }
    }
    throw new Error(`Store file does not exist: ${config.storePath}`)
  }
  const lines = readFileSync(config.storePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let failedRecords = 0
  let parsedRecords = 0
  let aliasedRecords = 0
  lines.forEach((line, order) => {
    try {
      const parsedRecord = validateStoreRecord(JSON.parse(decryptRecord(key, line)), order)
      const remapped = remapManagedStoreFilePath(parsedRecord.f, config)
      const record = remapped.aliased ? { ...parsedRecord, f: remapped.filePath } : parsedRecord
      if (remapped.aliased) aliasedRecords++
      const perFile = state.get(record.f) ?? new Map<string, VaultRecord>()
      const existing = perFile.get(record.k)
      if (!existing || isNewerRecord(record, existing)) perFile.set(record.k, record)
      state.set(record.f, perFile)
      parsedRecords++
    } catch {
      failedRecords++
    }
  })
  if (lines.length > 0 && parsedRecords === 0) {
    throw new Error(`No readable vault records found in ${config.storePath}. Check the key file.`)
  }
  return { state, failedRecords, parsedRecords, rawRecords: lines.length, aliasedRecords }
}

function append(config: VaultConfig, key: Buffer, record: VaultRecord): void {
  mkdirSync(path.dirname(config.storePath), { recursive: true })
  appendFileSync(config.storePath, `${encryptRecord(key, JSON.stringify(record))}\n`, 'utf8')
}

function createEmptyDocument(): EnvDocument {
  return { hasBom: false, eol: '\n', hasFinalNewline: true, lines: [] }
}

function createTextDocument(content: string): EnvDocument {
  const hasBom = content.startsWith('\uFEFF')
  const raw = hasBom ? content.slice(1) : content
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = raw.length > 0 && /\r?\n$/.test(raw)
  let lines = raw.length > 0 ? raw.split(/\r\n|\n/) : []
  if (hasFinalNewline && lines.at(-1) === '') lines = lines.slice(0, -1)
  return { hasBom, eol, hasFinalNewline, lines }
}

function renderTextDocument(document: EnvDocument, lines: string[]): string {
  const body = lines.join(document.eol)
  const withNewline = lines.length > 0 && document.hasFinalNewline ? `${body}${document.eol}` : body
  return document.hasBom ? `\uFEFF${withNewline}` : withNewline
}

function parseEnvLine(line: string): ParsedEnvLineData {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty', rawLine: line }
  if (trimmed.startsWith('#')) {
    const commentedEntryMatch = line.match(COMMENTED_ENV_ENTRY_RE)
    if (commentedEntryMatch) {
      const eqIdx = line.indexOf('=')
      return {
        kind: 'commented-entry',
        rawLine: line,
        key: commentedEntryMatch[1],
        prefix: line.slice(0, eqIdx + 1),
        rawValue: line.slice(eqIdx + 1),
      }
    }
    return { kind: 'comment', rawLine: line }
  }
  const eqIdx = line.indexOf('=')
  if (eqIdx < 0) return { kind: 'invalid', rawLine: line, reason: 'missing equals sign' }
  const match = line.match(ENV_ENTRY_RE)
  if (!match) return { kind: 'invalid', rawLine: line, reason: 'invalid env key' }
  return {
    kind: 'entry',
    rawLine: line,
    key: match[1],
    prefix: line.slice(0, eqIdx + 1),
    rawValue: line.slice(eqIdx + 1),
  }
}

function loadEnvDocument(filePath: string): LoadedEnvDocument {
  const fileExists = existsSync(filePath)
  const document = fileExists
    ? createTextDocument(readFileSync(filePath, 'utf8'))
    : createEmptyDocument()
  const parsedLines: ParsedEnvLine[] = document.lines.map((line, index) => ({
    lineNumber: index + 1,
    ...parseEnvLine(line),
  }))
  const currentMap = new Map<string, { value: string }>()
  const occurrencesMap = new Map<
    string,
    Array<{ value: string; prefix: string; lineNumber: number }>
  >()
  let invalidLineCount = 0
  let shadowedEntryCount = 0
  for (const line of parsedLines) {
    if (line.kind === 'entry') {
      const occurrences = occurrencesMap.get(line.key) ?? []
      occurrences.push({ value: line.rawValue, prefix: line.prefix, lineNumber: line.lineNumber })
      occurrencesMap.set(line.key, occurrences)
      if (currentMap.has(line.key)) shadowedEntryCount++
      currentMap.set(line.key, { value: line.rawValue })
    } else if (line.kind === 'invalid') {
      invalidLineCount++
    }
  }
  return {
    exists: fileExists,
    document,
    parsedLines,
    currentMap,
    occurrencesMap,
    invalidLineCount,
    shadowedEntryCount,
  }
}

function desiredRecordsForFile(
  config: VaultConfig,
  filePath: string,
  state: Map<string, Map<string, VaultRecord>>,
) {
  const desired = new Map<string, VaultRecord>()
  let excludedRecordsIgnored = 0
  for (const record of state.get(filePath)?.values() ?? []) {
    if (isExcluded(config, filePath, record.k)) {
      excludedRecordsIgnored++
      continue
    }
    desired.set(record.k, record)
  }
  return { desired, excludedRecordsIgnored }
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

function buildRestorePlanFromState(config: VaultConfig, store: StoreReadResult): RestorePlan {
  const files: RestorePlanFile[] = []
  const summary: RestorePlan['summary'] = {
    add: 0,
    modify: 0,
    delete: 0,
    identical: 0,
    filesWithChanges: 0,
  }
  const managedFiles = new Set(config.envFiles)
  const unmanagedStoreFiles = [...store.state.keys()].filter(
    (filePath) => !managedFiles.has(filePath),
  )
  let excludedRecordsIgnored = 0

  for (const filePath of config.envFiles) {
    const { desired, excludedRecordsIgnored: fileExcludedRecordsIgnored } = desiredRecordsForFile(
      config,
      filePath,
      store.state,
    )
    excludedRecordsIgnored += fileExcludedRecordsIgnored
    const envDoc = loadEnvDocument(filePath)
    const entries: RestorePlanEntry[] = []
    for (const record of desired.values()) {
      const occurrences = envDoc.occurrencesMap.get(record.k) ?? []
      const currentValues = occurrences.map((item) => item.value)
      let action: RestoreAction
      if (record.op === 'delete') action = occurrences.length === 0 ? 'identical' : 'delete'
      else if (occurrences.length === 0) action = 'add'
      else action = currentValues.every((value) => value === record.v) ? 'identical' : 'modify'
      summary[action]++
      entries.push({
        filePath,
        key: record.k,
        action,
        currentValues,
        occurrenceCount: occurrences.length,
        nextValue: record.op === 'set' ? record.v : undefined,
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
    excludedRecordsIgnored,
  }
}

function printRestorePreview(plan: RestorePlan): void {
  console.log('[env-lane:vault] Restore preview:')
  if (plan.summary.filesWithChanges === 0) {
    console.log('[env-lane:vault] No file changes detected.')
    console.log(`[env-lane:vault] Skipped identical key-value pairs: ${plan.summary.identical}`)
    return
  }

  for (const file of plan.files) {
    const changedEntries = file.entries.filter((entry) => entry.action !== 'identical')
    if (changedEntries.length === 0) continue
    console.log(`\n[env-lane:vault] File: ${file.filePath}`)
    for (const entry of changedEntries) {
      if (entry.action === 'add') {
        console.log(`  ADD ${entry.key}=${formatPreviewValue(entry.nextValue ?? '')}`)
      } else if (entry.action === 'modify') {
        console.log(
          `  MODIFY ${entry.key}: ${formatPreviewValues(entry.currentValues, entry.occurrenceCount)} -> ${formatPreviewValue(entry.nextValue ?? '')}`,
        )
      } else {
        console.log(
          `  DELETE ${entry.key}: ${formatPreviewValues(entry.currentValues, entry.occurrenceCount)}`,
        )
      }
    }
  }
  console.log('')
  console.log(
    `[env-lane:vault] Summary: ${plan.summary.modify} modify, ${plan.summary.add} add, ${plan.summary.delete} delete, ${plan.summary.identical} identical skipped`,
  )
}

async function confirmRestore(
  options: { autoApprove?: boolean; dryRun?: boolean } = {},
): Promise<boolean> {
  if (options.dryRun) return false
  if (options.autoApprove) {
    console.log('[env-lane:vault] Auto-approved restore.')
    return true
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Restore confirmation requires an interactive terminal. Re-run with --yes to apply or --dry-run to preview.',
    )
  }
  process.stdout.write('[env-lane:vault] Press y to apply restore, any other key to cancel: ')
  return new Promise((resolve) => {
    const stdin = process.stdin
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.pause()
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
    }
    const onData = (chunk: Buffer) => {
      cleanup()
      process.stdout.write('\n')
      const input = String(chunk)
      if (input === '\u0003') {
        resolve(false)
        return
      }
      resolve(
        input
          .replace(/[\r\n]+/g, '')
          .trim()
          .toLowerCase() === 'y',
      )
    }
    stdin.resume()
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
    stdin.once('data', onData)
  })
}

function applyRestoreFile(
  config: VaultConfig,
  filePath: string,
  state: Map<string, Map<string, VaultRecord>>,
): boolean {
  const { desired } = desiredRecordsForFile(config, filePath, state)
  const envDoc = loadEnvDocument(filePath)
  const seenKeys = new Set<string>()
  const nextLines: string[] = []

  for (const line of envDoc.parsedLines) {
    if (line.kind !== 'entry') {
      nextLines.push(line.rawLine)
      continue
    }
    const desiredRecord = desired.get(line.key)
    if (!desiredRecord) {
      nextLines.push(line.rawLine)
      continue
    }
    seenKeys.add(line.key)
    if (desiredRecord.op === 'delete') continue
    nextLines.push(`${line.prefix}${desiredRecord.v ?? ''}`)
  }

  const additions = [...desired.entries()]
    .filter(([key, record]) => record.op === 'set' && !seenKeys.has(key))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
  for (const [key, record] of additions) nextLines.push(`${key}=${record.v ?? ''}`)

  const current = envDoc.exists ? renderTextDocument(envDoc.document, envDoc.document.lines) : ''
  const next = renderTextDocument(envDoc.document, nextLines)
  if (current === next) return false
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, next, 'utf8')
  return true
}

export async function encryptEnvFiles(
  configPath: string,
  keyFilePath: string,
  options: { disableUnsafeWarning?: boolean } = {},
) {
  const config = loadVaultConfig(configPath)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const store = readStore(config, key, { allowMissing: true })
  const state = store.state
  let setRecordsWritten = 0
  let deleteRecordsWritten = 0
  let skippedUnchanged = 0
  let excludedEntriesIgnored = 0
  let missingFilesSkipped = 0
  let invalidLinesIgnored = 0
  let shadowedEntriesIgnored = 0

  for (const filePath of config.envFiles) {
    if (!existsSync(filePath)) {
      missingFilesSkipped++
      continue
    }
    const envDoc = loadEnvDocument(filePath)
    const prev = state.get(filePath) ?? new Map<string, VaultRecord>()
    const current = new Map<string, string>()
    for (const [keyName, { value }] of envDoc.currentMap) {
      if (isExcluded(config, filePath, keyName)) {
        excludedEntriesIgnored++
        continue
      }
      current.set(keyName, value)
      const old = prev.get(keyName)
      if (old?.op === 'set' && old.v === value) {
        skippedUnchanged++
        continue
      }
      append(config, key, { f: filePath, k: keyName, v: value, op: 'set', t: Date.now() })
      emitStructuredChange('encrypt', {
        action: old?.op === 'set' ? 'update' : 'set',
        filePath: portable(filePath),
        key: keyName,
      })
      setRecordsWritten++
    }
    if (config.trackDeletions) {
      for (const [keyName, old] of prev.entries()) {
        if (old.op === 'set' && !current.has(keyName)) {
          append(config, key, { f: filePath, k: keyName, op: 'delete', t: Date.now() })
          emitStructuredChange('encrypt', {
            action: 'delete',
            filePath: portable(filePath),
            key: keyName,
            excluded: isExcluded(config, filePath, keyName) || undefined,
          })
          deleteRecordsWritten++
        }
      }
    }
    invalidLinesIgnored += envDoc.invalidLineCount
    shadowedEntriesIgnored += envDoc.shadowedEntryCount
  }
  return {
    storePath: config.storePath,
    setRecordsWritten,
    deleteRecordsWritten,
    skippedUnchanged,
    excludedEntriesIgnored,
    missingFilesSkipped,
    invalidLinesIgnored,
    shadowedEntriesIgnored,
    rawRecords: store.rawRecords,
    parsedRecords: store.parsedRecords,
    failedRecords: store.failedRecords,
    aliasedRecords: store.aliasedRecords,
  }
}

export async function buildRestorePlan(
  configPath: string,
  keyFilePath: string,
  options: { disableUnsafeWarning?: boolean } = {},
) {
  const config = loadVaultConfig(configPath)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  return buildRestorePlanFromState(config, readStore(config, key))
}

export async function decryptEnvFiles(
  configPath: string,
  keyFilePath: string,
  options: { dryRun?: boolean; autoApprove?: boolean; disableUnsafeWarning?: boolean } = {},
) {
  const config = loadVaultConfig(configPath)
  warnUnsafeVault({
    disableUnsafeWarning: options.disableUnsafeWarning ?? config.disableUnsafeWarning,
  })
  const key = deriveVaultKey(keyFilePath)
  const store = readStore(config, key)
  const plan = buildRestorePlanFromState(config, store)
  printRestorePreview(plan)
  if (plan.failedRecords > 0) {
    console.warn(
      `[env-lane:vault] Warning: skipped ${plan.failedRecords} unreadable store record(s).`,
    )
  }
  if (plan.aliasedRecords > 0) {
    console.log(
      `[env-lane:vault] Remapped ${plan.aliasedRecords} store record(s) from previous checkout paths to current env files.`,
    )
  }
  if (plan.unmanagedStoreFiles.length > 0) {
    console.warn(
      `[env-lane:vault] Warning: ignored ${plan.unmanagedStoreFiles.length} store file(s) not listed in config.envFiles.`,
    )
  }
  if (plan.excludedRecordsIgnored > 0) {
    console.log(
      `[env-lane:vault] Ignored ${plan.excludedRecordsIgnored} excluded store record(s) during restore.`,
    )
  }

  const results: Array<{
    filePath: string
    keys: number
    changed: boolean
    entries: RestorePlanEntry[]
  }> = []
  if (plan.summary.filesWithChanges === 0 || options.dryRun) {
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
    console.log('[env-lane:vault] Restore cancelled. No files were changed.')
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
    if (!file.changed) {
      results.push({
        filePath: file.filePath,
        keys: file.entries.filter((entry) => entry.action !== 'delete').length,
        changed: false,
        entries: file.entries,
      })
      continue
    }
    const changed = applyRestoreFile(config, file.filePath, store.state)
    if (changed) {
      filesWritten++
      for (const entry of file.entries.filter((item) => item.action !== 'identical')) {
        emitStructuredChange('decrypt', {
          action: entry.action,
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
  return { ...plan, applied: filesWritten > 0, filesWritten, results }
}

export async function runVault(
  configPath: string,
  keyFilePath: string,
  mode: 'encrypt' | 'decrypt',
  options: { dryRun?: boolean; autoApprove?: boolean; disableUnsafeWarning?: boolean } = {},
) {
  return mode === 'encrypt'
    ? encryptEnvFiles(configPath, keyFilePath, options)
    : decryptEnvFiles(configPath, keyFilePath, options)
}
