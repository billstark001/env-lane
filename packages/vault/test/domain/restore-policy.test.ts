import { describe, expect, it } from 'vitest'
import {
  buildDefaultRestoreDecisions,
  matchesVaultPushSelection,
  matchesVaultSelection,
  parseVaultFailCondition,
  type RestoreAction,
  type RestorePlan,
  type RestorePlanEntry,
  restorePlanMatchesFailCondition,
  selectRestorePlan,
  selectRestorePlanByDecisions,
} from '../../src/index.js'

function entry(
  action: RestoreAction,
  key = 'API_KEY',
  filePath = '/workspace/apps/api/.env',
): RestorePlanEntry {
  return {
    entryId: `${action}-${key}`.padEnd(64, '0').slice(0, 64),
    filePath,
    key,
    action,
    occurrenceCount: action === 'delete' ? 0 : 1,
    preview: { current: '<redacted>', vault: '<redacted>' },
  }
}

function plan(entries: RestorePlanEntry[]): RestorePlan {
  const summary = {
    add: 0,
    modify: 0,
    delete: 0,
    identical: 0,
    conflict: 0,
    filesWithChanges: entries.some((item) => item.action !== 'identical') ? 1 : 0,
  }
  for (const item of entries) summary[item.action]++
  return {
    version: 1,
    createdAt: 0,
    planDigest: '0'.repeat(64),
    storeDigest: '0'.repeat(64),
    storePath: '/workspace/.vault/store.dat',
    files: [{ filePath: '/workspace/apps/api/.env', entries, changed: true }],
    summary,
    failedRecords: 0,
    parsedRecords: entries.length,
    rawRecords: entries.length,
    aliasedRecords: 0,
    unmanagedStoreFiles: [],
  }
}

describe('Vault selection and fail-on policies', () => {
  const modify = entry('modify')

  it.each([
    ['--file', { file: '**/api/.env' }],
    ['--key', { key: 'API_*' }],
    ['--include', { include: '**/api/.env:API_KEY' }],
    ['--exclude non-match', { exclude: '**:OTHER_*' }],
    ['--only', { only: 'modify' }],
  ])('matches an entry using %s independently', (_label, options) => {
    expect(matchesVaultSelection(modify, options)).toBe(true)
  })

  it('applies negative filters and rejects invalid --only values', () => {
    expect(matchesVaultSelection(modify, { file: '**/web/.env' })).toBe(false)
    expect(matchesVaultSelection(modify, { key: 'OTHER_*' })).toBe(false)
    expect(matchesVaultSelection(modify, { include: '**:OTHER_*' })).toBe(false)
    expect(matchesVaultSelection(modify, { exclude: '**:API_*' })).toBe(false)
    expect(matchesVaultSelection(modify, { only: 'add' })).toBe(false)
    expect(() => matchesVaultSelection(modify, { only: 'unknown' })).toThrow(/unknown action/)
  })

  it('requires --approve-deletes for push and default restore selection', () => {
    const deletion = entry('delete')
    expect(matchesVaultPushSelection(deletion, {})).toBe(false)
    expect(matchesVaultPushSelection(deletion, { approveDeletes: true })).toBe(true)
    expect(buildDefaultRestoreDecisions(plan([deletion]), {})).toEqual([
      { entryId: deletion.entryId, decision: 'skip' },
    ])
    expect(buildDefaultRestoreDecisions(plan([deletion]), { approveDeletes: true })).toEqual([
      { entryId: deletion.entryId, decision: 'apply-vault' },
    ])
  })

  it('projects plans and summaries to the selected entries', () => {
    const auditedPlan = plan([entry('add', 'NEW_KEY'), entry('modify'), entry('conflict', 'OLD')])
    const selected = selectRestorePlan(auditedPlan, { key: 'API_*', only: 'modify' })

    expect(selected.files.flatMap((file) => file.entries)).toEqual([entry('modify')])
    expect(selected.summary).toEqual({
      add: 0,
      modify: 1,
      delete: 0,
      identical: 0,
      conflict: 0,
      filesWithChanges: 1,
    })
    expect(auditedPlan.summary.conflict).toBe(1)

    const emptySelection = selectRestorePlan(auditedPlan, { key: 'MISSING_*' })
    expect(emptySelection.files).toEqual([])
    expect(emptySelection.summary).toEqual({
      add: 0,
      modify: 0,
      delete: 0,
      identical: 0,
      conflict: 0,
      filesWithChanges: 0,
    })
  })

  it('projects applied plans from explicit decisions instead of editable summaries', () => {
    const modify = entry('modify')
    const conflict = entry('conflict', 'CONFLICT')
    const auditedPlan = plan([modify, conflict, entry('delete', 'DELETE')])
    auditedPlan.summary = {
      add: 99,
      modify: 99,
      delete: 99,
      identical: 99,
      conflict: 99,
      filesWithChanges: 99,
    }

    const selected = selectRestorePlanByDecisions(auditedPlan, [
      { entryId: modify.entryId, decision: 'skip' },
      { entryId: conflict.entryId, decision: 'keep-local' },
    ])

    expect(selected.files.flatMap((file) => file.entries)).toEqual([conflict])
    expect(selected.summary).toEqual({
      add: 0,
      modify: 0,
      delete: 0,
      identical: 0,
      conflict: 1,
      filesWithChanges: 1,
    })
  })

  it('evaluates every --fail-on condition and validates input', () => {
    const auditedPlan = plan([entry('conflict')])
    auditedPlan.failedRecords = 1
    expect(restorePlanMatchesFailCondition(auditedPlan, 'conflict')).toBe(true)
    expect(restorePlanMatchesFailCondition(auditedPlan, 'change')).toBe(true)
    expect(restorePlanMatchesFailCondition(auditedPlan, 'warning')).toBe(true)
    expect(restorePlanMatchesFailCondition(auditedPlan, undefined)).toBe(false)
    expect(parseVaultFailCondition('change')).toBe('change')
    expect(() => parseVaultFailCondition('invalid')).toThrow(/--fail-on/)
  })
})
