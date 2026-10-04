/// <reference path="../picomatch.d.ts" />

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError, writeFileContentAtomically } from '@env-lane/core'
import picomatch from 'picomatch'
import { z } from 'zod'
import { loadVaultConfig, type VaultConfig } from '../adapters/config.js'
import { callNativeVault } from '../adapters/native.js'
import { resolveFromDirectory, resolveInvocationCwd } from '../adapters/paths.js'
import type {
  RestoreAction,
  RestoreDecision,
  RestoreDecisionChoice,
  RestorePlan,
  RestorePlanEntry,
  VaultConflictStrategy,
  VaultRestoreRedaction,
  VaultRestoreReveal,
} from '../domain/types.js'
import { selectEntryWithCallback } from './selection.js'
import { portable, withVaultOperationLock } from './storage.js'
import { resolveConflict } from './sync.js'

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

function nativeBuildRestorePlan(
  config: VaultConfig,
  keyFilePath: string,
  invocationCwd: string,
  options: BuildRestorePlanOptions,
  externalLock = false,
): RestorePlan {
  // Only the callback path passes true while holding withVaultOperationLock.
  return callNativeVault<RestorePlan>('vault.buildRestorePlan', {
    cwd: invocationCwd,
    keyFile: keyFilePath,
    config,
    ignoreCorruptRecords: options.ignoreCorruptRecords,
    syncDir: options.syncDir,
    skipOperationLock: externalLock,
  })
}

/** Read Vault and local files into a redacted, no-write restore plan. */
export async function buildRestorePlan(
  configPath: string | undefined,
  keyFilePath: string,
  options: BuildRestorePlanOptions = {},
) {
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const config =
    options.resolvedConfig ??
    (await loadVaultConfig(configPath, { ...options, cwd: invocationCwd }))
  return nativeBuildRestorePlan(config, keyFilePath, invocationCwd, options)
}

/** Build a fresh plan, then apply it unless `dryRun` is set. */
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
  plan: RestorePlan,
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
    if (!decision && options.selectEntry && !selectEntryWithCallback(options.selectEntry, entry))
      decision = 'skip'
    if (!decision && entry.action === 'delete' && options.approveDeletes === false)
      decision = 'skip'
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

function assertFreshRestorePlan(submitted: RestorePlan, current: RestorePlan): void {
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

/** Result of applying a previously built Vault restore plan. */
interface ApplyRestoreResult extends RestorePlan {
  applied: boolean
  filesWritten: number
  results: Array<{
    filePath: string
    keys: number
    changed: boolean
    entries: RestorePlanEntry[]
  }>
  decisions: RestoreDecision[]
  appliedEntries: number
  skippedEntries: number
  conflictsKeptLocal: number
  conflictsTookVault: number
  syncStatePath?: string
  syncStateMigratedFromVersion0: boolean
}

/**
 * Apply a submitted plan only after native code verifies its digest and current
 * inputs. JavaScript callbacks run before native apply under one operation lock.
 */
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
  const request = {
    cwd: invocationCwd,
    keyFile: keyFilePath,
    config,
    plan: submittedPlan,
    syncDir: options.syncDir,
    ignoreCorruptRecords: options.ignoreCorruptRecords,
    autoApprove: options.autoApprove,
    approveDeletes: options.approveDeletes,
    conflictStrategy: options.conflictStrategy,
  }
  let decisions = options.decisions
  if (options.selectEntry || options.resolveConflict) {
    return withVaultOperationLock(config, async () => {
      const current = nativeBuildRestorePlan(config, keyFilePath, invocationCwd, options, true)
      assertFreshRestorePlan(submittedPlan, current)
      decisions = (await chooseRestoreEntries(current, options)).resolved
      return callNativeVault<ApplyRestoreResult>('vault.applyRestorePlan', {
        ...request,
        decisions,
        skipOperationLock: true,
      })
    })
  }
  return callNativeVault<ApplyRestoreResult>('vault.applyRestorePlan', {
    ...request,
    decisions,
  })
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

/** Persist only the plan identity and explicit decisions for later review. */
export function createApprovalDocument(
  plan: RestorePlan,
  options: VaultSelectionOptions,
): ApprovalDocument {
  return { plan, decisions: buildDefaultRestoreDecisions(plan, options) }
}

/** Validate an approval file before it is used to apply a plan. */
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
  /** Delete entries are selected by default; set false to skip them. */
  approveDeletes?: boolean
}

function parseOnly(value: string | undefined): Set<RestoreAction> | undefined {
  if (value === undefined) return undefined
  const actions = value.split(',').map((item) => item.trim())
  const allowed: RestoreAction[] = ['add', 'modify', 'delete', 'identical', 'conflict']
  if (actions.some((action) => !allowed.includes(action as RestoreAction))) {
    throw new EnvLaneError('VAULT_INVALID_FILTER', '--only contains an unknown action.')
  }
  return new Set(actions as RestoreAction[])
}

function globMatcher(pattern: string): (value: string) => boolean {
  const direct = selectionGlob(pattern)
  const nested = path.isAbsolute(pattern) ? undefined : selectionGlob(`**/${pattern}`)
  return (value) => direct(value) || Boolean(nested?.(value))
}

function selectionGlob(pattern: string): (value: string) => boolean {
  if (!pattern) {
    throw new EnvLaneError('VAULT_INVALID_FILTER', 'Vault pattern must be a non-empty string.')
  }
  try {
    return picomatch(pattern, { dot: true })
  } catch (error) {
    throw new EnvLaneError('VAULT_INVALID_FILTER', `Invalid Vault pattern: ${pattern}`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Compile a selection once when checking every entry in a plan. */
export function createVaultSelectionMatcher(options: VaultSelectionOptions) {
  const only = parseOnly(options.only)
  const fileMatches = options.file === undefined ? undefined : globMatcher(options.file)
  const keyMatches = options.key === undefined ? undefined : selectionGlob(options.key)
  const included = options.include === undefined ? undefined : globMatcher(options.include)
  const excluded = options.exclude === undefined ? undefined : globMatcher(options.exclude)
  return (entry: RestorePlanEntry): boolean => {
    const file = portable(entry.filePath)
    const pair = `${file}:${entry.key}`
    if (only && !only.has(entry.action)) return false
    if (fileMatches && !fileMatches(file)) return false
    if (keyMatches && !keyMatches(entry.key)) return false
    if (included && !included(pair)) return false
    if (excluded?.(pair)) return false
    return true
  }
}

export function matchesVaultSelection(
  entry: RestorePlanEntry,
  options: VaultSelectionOptions,
): boolean {
  return createVaultSelectionMatcher(options)(entry)
}

export function matchesVaultPushSelection(
  entry: RestorePlanEntry,
  options: VaultSelectionOptions,
): boolean {
  return createVaultPushSelectionMatcher(options)(entry)
}

/** Prepare the push filter once before invoking it for every candidate. */
export function createVaultPushSelectionMatcher(options: VaultSelectionOptions) {
  const selected = createVaultSelectionMatcher(options)
  return (entry: RestorePlanEntry): boolean => {
    if (!selected(entry)) return false
    const deletes = entry.action === 'delete' || entry.vaultAction === 'delete'
    return !deletes || options.approveDeletes !== false
  }
}

export function selectRestorePlan(plan: RestorePlan, options: VaultSelectionOptions): RestorePlan {
  return filterRestorePlan(plan, createVaultSelectionMatcher(options))
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
  const selected = createVaultSelectionMatcher(options)
  return plan.files.flatMap((file) =>
    file.entries
      .filter((entry) => entry.action !== 'identical')
      .map((entry) => {
        let decision: RestoreDecision['decision'] = 'skip'
        if (selected(entry)) {
          if (entry.action === 'conflict') {
            if (strategy === 'take-vault') decision = 'apply-vault'
            else if (strategy === 'keep-local') decision = 'keep-local'
          } else if (entry.action !== 'delete' || options.approveDeletes !== false) {
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
  const selected = createVaultSelectionMatcher(options)
  return plan.files
    .flatMap((file) => file.entries)
    .some(
      (entry) =>
        entry.action === 'conflict' && selected(entry) && decisionMap.get(entry.entryId) === 'skip',
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
