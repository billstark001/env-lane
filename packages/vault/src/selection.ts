import path from 'node:path'
import { EnvLaneError } from '@env-lane/core'
import picomatch from 'picomatch'
import type {
  RestoreAction,
  RestoreDecision,
  RestorePlan,
  RestorePlanEntry,
  VaultConflictStrategy,
} from './store.js'

export interface VaultSelectionOptions {
  file?: string
  key?: string
  include?: string
  exclude?: string
  only?: string
  approveDeletes?: boolean
}

function portable(value: string): string {
  return value.replace(/\\/g, '/')
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
