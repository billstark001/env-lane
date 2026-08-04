import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError, writeFileContentAtomically } from '@env-lane/core'
import { applyEnvDocumentPatches, loadEnvDocument } from '@env-lane/core/env-document'
import picomatch from 'picomatch'
import { z } from 'zod'
import { loadVaultConfig, type VaultConfig } from '../adapters/config.js'
import { deriveVaultKey, keyedDigest, stableHash } from '../adapters/crypto.js'
import { type AbsolutePath, resolveFromDirectory, resolveInvocationCwd } from '../adapters/paths.js'
import { restoreCurrentPreview, restoreValuePreview } from '../domain/restore-preview.js'
import type {
  RestoreAction,
  RestoreDecision,
  RestoreDecisionChoice,
  RestorePlan,
  RestorePlanEntry,
  RestorePlanFile,
  VaultConflictStrategy,
  VaultRecord,
  VaultRestoreRedaction,
  VaultRestoreReveal,
} from '../domain/types.js'
import {
  assertNoExcludedHistory,
  desiredRecordsForFile,
  portable,
  readStore,
  type StoreReadResult,
  withVaultOperationLock,
} from './storage.js'
import {
  loadSyncContext,
  recordValueFingerprint,
  resolveConflict,
  restoreConflictCheck,
  type SyncContext,
  saveSyncContext,
  scrubExcludedSyncEntries,
  updateSyncEntry,
} from './sync.js'

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
          current: restoreCurrentPreview(
            record.k,
            currentValues,
            config.restore.redaction,
            config.restore.reveal,
          ),
          vault:
            record.op === 'delete'
              ? '<delete>'
              : restoreValuePreview(
                  record.k,
                  record.v ?? '',
                  config.restore.redaction,
                  config.restore.reveal,
                ),
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

interface BuildRestorePlanOptions {
  cwd?: string
  ignoreCorruptRecords?: boolean
  syncDir?: string
  vaultConfigFile?: string
  autoRemapPaths?: boolean
  allowUnmanaged?: boolean
  restoreRedaction?: VaultRestoreRedaction
  restoreReveal?: VaultRestoreReveal | false
  resolvedConfig?: VaultConfig
}

function buildRestorePlanLocked(
  config: VaultConfig,
  key: Buffer,
  syncDir: AbsolutePath | undefined,
  options: BuildRestorePlanOptions,
): RestorePlan {
  const syncContext = loadSyncContext(syncDir, key)
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
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const config =
    options.resolvedConfig ??
    (await loadVaultConfig(configPath, { ...options, cwd: invocationCwd }))
  const key = deriveVaultKey(resolveFromDirectory(invocationCwd, keyFilePath))
  const syncDir = options.syncDir ? resolveFromDirectory(invocationCwd, options.syncDir) : undefined
  return withVaultOperationLock(config, async () =>
    buildRestorePlanLocked(config, key, syncDir, options),
  )
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
    restoreRedaction?: VaultRestoreRedaction
    restoreReveal?: VaultRestoreReveal | false
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
  restoreRedaction?: VaultRestoreRedaction
  restoreReveal?: VaultRestoreReveal | false
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
  syncDir: AbsolutePath | undefined,
  submittedPlan: RestorePlan,
  options: ApplyRestoreOptions,
) {
  const syncContext = loadSyncContext(syncDir, key)
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
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const config =
    options.resolvedConfig ??
    (await loadVaultConfig(configPath, { ...options, cwd: invocationCwd }))
  const key = deriveVaultKey(resolveFromDirectory(invocationCwd, keyFilePath))
  const syncDir = options.syncDir ? resolveFromDirectory(invocationCwd, options.syncDir) : undefined
  return withVaultOperationLock(config, () =>
    applyRestorePlanLocked(config, key, syncDir, submittedPlan, options),
  )
}

const restoreActionSchema = z.enum(['add', 'modify', 'delete', 'identical', 'conflict'])
const restorePlanEntrySchema = z.object({
  entryId: z.string().length(64),
  filePath: z.string().min(1),
  key: z.string().min(1),
  action: restoreActionSchema,
  occurrenceCount: z.number().int().nonnegative(),
  conflict: z.boolean().optional(),
  vaultAction: z.enum(['add', 'modify', 'delete', 'identical']).optional(),
  conflictReason: z.string().optional(),
  preview: z.object({ current: z.string(), vault: z.string() }),
})
const restorePlanSchema = z.object({
  version: z.literal(1),
  createdAt: z.number().nonnegative(),
  planDigest: z.string().length(64),
  storeDigest: z.string().length(64),
  storePath: z.string().min(1),
  files: z.array(
    z.object({
      filePath: z.string().min(1),
      entries: z.array(restorePlanEntrySchema),
      changed: z.boolean(),
    }),
  ),
  summary: z.object({
    add: z.number().int().nonnegative(),
    modify: z.number().int().nonnegative(),
    delete: z.number().int().nonnegative(),
    identical: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    filesWithChanges: z.number().int().nonnegative(),
  }),
  failedRecords: z.number().int().nonnegative(),
  parsedRecords: z.number().int().nonnegative(),
  rawRecords: z.number().int().nonnegative(),
  aliasedRecords: z.number().int().nonnegative(),
  unmanagedStoreFiles: z.array(z.string()),
})
const decisionSchema = z.object({
  entryId: z.string().length(64),
  decision: z.enum(['apply-vault', 'keep-local', 'skip']),
})
const approvalDocumentSchema = z.object({
  plan: restorePlanSchema,
  decisions: z.array(decisionSchema),
})

export interface ApprovalDocument {
  plan: RestorePlan
  decisions: RestoreDecision[]
}

export function createApprovalDocument(
  plan: RestorePlan,
  options: VaultSelectionOptions,
): ApprovalDocument {
  return { plan, decisions: buildDefaultRestoreDecisions(plan, options) }
}

export function readApprovalDocument(filePath: string): ApprovalDocument {
  try {
    const resolvedFilePath = resolveFromDirectory(resolveInvocationCwd(), filePath)
    const document = approvalDocumentSchema.parse(
      JSON.parse(readFileSync(resolvedFilePath, 'utf8')),
    ) as ApprovalDocument
    const expectedIds = new Set(
      document.plan.files.flatMap((file) =>
        file.entries.filter((entry) => entry.action !== 'identical').map((entry) => entry.entryId),
      ),
    )
    const decisionIds = new Set(document.decisions.map((decision) => decision.entryId))
    if (
      decisionIds.size !== document.decisions.length ||
      decisionIds.size !== expectedIds.size ||
      [...decisionIds].some((entryId) => !expectedIds.has(entryId))
    ) {
      throw new Error('Decisions must cover every non-identical plan entry exactly once.')
    }
    return document
  } catch (error) {
    throw new EnvLaneError('VAULT_INVALID_PLAN_FILE', 'Invalid Vault approval document.', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

export function writeApprovalDocument(filePath: string, document: ApprovalDocument): void {
  const resolvedFilePath = resolveFromDirectory(resolveInvocationCwd(), filePath)
  writeFileContentAtomically(resolvedFilePath, `${JSON.stringify(document, null, 2)}\n`)
}

export interface VaultSelectionOptions {
  file?: string
  key?: string
  include?: string
  exclude?: string
  only?: string
  approveDeletes?: boolean
}

function parseOnly(value: string | undefined): Set<RestoreAction> | undefined {
  if (!value) return undefined
  const actions = value.split(',').map((item) => item.trim())
  const allowed: RestoreAction[] = ['add', 'modify', 'delete', 'identical', 'conflict']
  if (actions.some((action) => !allowed.includes(action as RestoreAction))) {
    throw new EnvLaneError('VAULT_INVALID_FILTER', '--only contains an unknown action.')
  }
  return new Set(actions as RestoreAction[])
}

function matchesGlob(value: string, pattern: string): boolean {
  const direct = picomatch(pattern, { dot: true })
  if (direct(value)) return true
  return !path.isAbsolute(pattern) && picomatch(`**/${pattern}`, { dot: true })(value)
}

export function matchesVaultSelection(
  entry: RestorePlanEntry,
  options: VaultSelectionOptions,
): boolean {
  const file = portable(entry.filePath)
  const pair = `${file}:${entry.key}`
  const only = parseOnly(options.only)
  if (only && !only.has(entry.action)) return false
  if (options.file && !matchesGlob(file, options.file)) return false
  if (options.key && !picomatch(options.key, { dot: true })(entry.key)) return false
  if (options.include && !matchesGlob(pair, options.include)) return false
  if (options.exclude && matchesGlob(pair, options.exclude)) return false
  return true
}

export function matchesVaultPushSelection(
  entry: RestorePlanEntry,
  options: VaultSelectionOptions,
): boolean {
  if (!matchesVaultSelection(entry, options)) return false
  const deletes = entry.action === 'delete' || entry.vaultAction === 'delete'
  return !deletes || Boolean(options.approveDeletes)
}

export function selectRestorePlan(plan: RestorePlan, options: VaultSelectionOptions): RestorePlan {
  return filterRestorePlan(plan, (entry) => matchesVaultSelection(entry, options))
}

export function selectRestorePlanByDecisions(
  plan: RestorePlan,
  decisions: readonly RestoreDecision[],
): RestorePlan {
  const selectedIds = new Set(
    decisions.filter((item) => item.decision !== 'skip').map((item) => item.entryId),
  )
  return filterRestorePlan(plan, (entry) => selectedIds.has(entry.entryId))
}

function filterRestorePlan(
  plan: RestorePlan,
  predicate: (entry: RestorePlanEntry) => boolean,
): RestorePlan {
  const files = plan.files
    .map((file) => {
      const entries = file.entries.filter(predicate)
      return {
        ...file,
        entries,
        changed: entries.some((entry) => entry.action !== 'identical'),
      }
    })
    .filter((file) => file.entries.length > 0)
  const summary: RestorePlan['summary'] = {
    add: 0,
    modify: 0,
    delete: 0,
    identical: 0,
    conflict: 0,
    filesWithChanges: files.filter((file) => file.changed).length,
  }
  for (const entry of files.flatMap((file) => file.entries)) summary[entry.action] += 1
  return { ...plan, files, summary }
}

export function buildDefaultRestoreDecisions(
  plan: RestorePlan,
  options: VaultSelectionOptions,
  strategy: VaultConflictStrategy = 'abort',
): RestoreDecision[] {
  return plan.files.flatMap((file) =>
    file.entries
      .filter((entry) => entry.action !== 'identical')
      .map((entry) => {
        let decision: RestoreDecision['decision'] = 'skip'
        if (matchesVaultSelection(entry, options)) {
          if (entry.action === 'conflict') {
            if (strategy === 'take-vault') decision = 'apply-vault'
            else if (strategy === 'keep-local') decision = 'keep-local'
          } else if (entry.action !== 'delete' || options.approveDeletes) {
            decision = 'apply-vault'
          }
        }
        return { entryId: entry.entryId, decision }
      }),
  )
}

export function hasUnresolvedSelectedConflict(
  plan: RestorePlan,
  decisions: RestoreDecision[],
  options: VaultSelectionOptions,
): boolean {
  const decisionMap = new Map(decisions.map((item) => [item.entryId, item.decision]))
  return plan.files
    .flatMap((file) => file.entries)
    .some(
      (entry) =>
        entry.action === 'conflict' &&
        matchesVaultSelection(entry, options) &&
        decisionMap.get(entry.entryId) === 'skip',
    )
}

export type VaultFailCondition = 'conflict' | 'change' | 'warning'

export function parseVaultFailCondition(value: string | undefined): VaultFailCondition | undefined {
  if (value === undefined) return undefined
  if (value === 'conflict' || value === 'change' || value === 'warning') return value
  throw new EnvLaneError('VAULT_INVALID_FAIL_ON', '--fail-on must be conflict, change, or warning.')
}

export function restorePlanMatchesFailCondition(
  plan: RestorePlan,
  condition: VaultFailCondition | undefined,
): boolean {
  if (condition === 'conflict') return plan.summary.conflict > 0
  if (condition === 'change') return plan.summary.filesWithChanges > 0
  if (condition === 'warning') {
    return plan.failedRecords > 0 || plan.unmanagedStoreFiles.length > 0
  }
  return false
}
