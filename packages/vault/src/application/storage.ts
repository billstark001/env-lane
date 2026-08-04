/// <reference path="../picomatch.d.ts" />

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError, writeFileContentAtomically } from '@env-lane/core'
import { parseEnvLine } from '@env-lane/core/env-document'
import picomatch from 'picomatch'
import { loadVaultConfig, type VaultConfig } from '../adapters/config.js'
import { decryptRecord, deriveVaultKey, encryptRecord, stableHash } from '../adapters/crypto.js'
import { withFileLock } from '../adapters/file-lock.js'
import { resolveFromDirectory, resolveInvocationCwd } from '../adapters/paths.js'
import { encodeVaultRecordPath, resolveVaultRecordPath } from '../adapters/record-path.js'
import type { VaultRecord } from '../domain/types.js'

export interface StoreReadResult {
  records: StoreRecordLine[]
  state: Map<string, Map<string, VaultRecord>>
  failedRecords: number
  parsedRecords: number
  rawRecords: number
  aliasedRecords: number
}

export interface StoreRecordLine {
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

interface PruneCandidate {
  index: number
  record: VaultRecord
}

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

export function portable(file: string): string {
  return file.replace(/\\/g, '/').replaceAll(path.sep, '/')
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

export function isExcluded(config: VaultConfig, filePath: string, key: string): boolean {
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

function validateStoreRecord(decoded: unknown, order: number, config: VaultConfig): VaultRecord {
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
    f: version === 1 ? resolveVaultRecordPath(config.baseDir, raw.f) : path.resolve(raw.f),
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
      const parsedRecord = validateStoreRecord(JSON.parse(decryptRecord(key, line)), order, config)
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

export function readStore(
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

function serializeRecord(config: VaultConfig, key: Buffer, record: VaultRecord): string {
  const { version, f, k, t, op, v } = record
  const storedFilePath = version === 1 ? encodeVaultRecordPath(config.baseDir, f) : f
  return encryptRecord(key, JSON.stringify({ version, f: storedFilePath, k, t, op, v }))
}

export async function appendRecordsAtomically(
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
      `${prefix}${records.map((record) => serializeRecord(config, key, record)).join('\n')}\n`,
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

export function withVaultOperationLock<T>(
  config: VaultConfig,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(`${config.storePath}.operation`, operation)
}

function excludedHistoricalRecords(config: VaultConfig, records: StoreRecordLine[]) {
  return records.filter((item) => isExcluded(config, item.groupFilePath, item.record.k))
}

export function assertNoExcludedHistory(
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

export function desiredRecordsForFile(
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
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const config =
    options.resolvedConfig ??
    (await loadVaultConfig(configPath, { ...options, cwd: invocationCwd }))
  const key = deriveVaultKey(resolveFromDirectory(invocationCwd, keyFilePath))
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
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const config =
    options.resolvedConfig ??
    (await loadVaultConfig(configPath, { ...options, cwd: invocationCwd }))
  const key = deriveVaultKey(resolveFromDirectory(invocationCwd, keyFilePath))
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
