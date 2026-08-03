import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestorePlan, RestorePlanEntry } from '../../src/domain/types.js'

const promptMocks = vi.hoisted(() => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  checkbox: promptMocks.checkbox,
  confirm: promptMocks.confirm,
  Separator: class Separator {
    constructor(readonly separator: string) {}
  },
}))

import { promptRestoreDecisions, promptStoreRewrite } from '../../src/cli/prompts.js'

function entry(action: RestorePlanEntry['action'], key: string): RestorePlanEntry {
  return {
    entryId: `${action}-${key}`.padEnd(64, '0').slice(0, 64),
    filePath: '/workspace/.env',
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
    filesWithChanges: entries.length > 0 ? 1 : 0,
  }
  for (const item of entries) summary[item.action]++
  return {
    version: 1,
    createdAt: 0,
    planDigest: '0'.repeat(64),
    storeDigest: '0'.repeat(64),
    storePath: '/workspace/.vault/store.dat',
    files: [{ filePath: '/workspace/.env', entries, changed: entries.length > 0 }],
    summary,
    failedRecords: 0,
    parsedRecords: entries.length,
    rawRecords: entries.length,
    aliasedRecords: 0,
    unmanagedStoreFiles: [],
  }
}

describe('Vault interactive prompts', () => {
  let stdinTTY: boolean | undefined
  let stderrTTY: boolean | undefined

  beforeEach(() => {
    stdinTTY = process.stdin.isTTY
    stderrTTY = process.stderr.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
    promptMocks.checkbox.mockReset()
    promptMocks.confirm.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true })
    Object.defineProperty(process.stderr, 'isTTY', { value: stderrTTY, configurable: true })
  })

  it('leaves deletes unselected and maps unselected conflicts to keep-local', async () => {
    const deletion = entry('delete', 'DELETE_ME')
    const conflict = entry('conflict', 'CONFLICT')
    promptMocks.checkbox.mockResolvedValue([])
    promptMocks.confirm.mockResolvedValue(true)

    await expect(promptRestoreDecisions(plan([deletion, conflict]), {})).resolves.toEqual([
      { entryId: deletion.entryId, decision: 'skip' },
      { entryId: conflict.entryId, decision: 'keep-local' },
    ])
    const choices = promptMocks.checkbox.mock.calls[0][0].choices
    expect(
      choices.find((choice: { value?: string }) => choice.value === deletion.entryId),
    ).toMatchObject({
      checked: false,
    })
  })

  it('handles an empty plan without inventing decisions', async () => {
    promptMocks.checkbox.mockResolvedValue([])
    promptMocks.confirm.mockResolvedValue(true)
    await expect(promptRestoreDecisions(plan([]), {})).resolves.toEqual([])
  })

  it('turns prompt cancellation into a stable Vault cancellation error', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'ExitPromptError' })
    promptMocks.confirm.mockRejectedValue(cancellation)
    await expect(promptStoreRewrite('Rewrite?')).rejects.toMatchObject({
      code: 'VAULT_CANCELLED',
    })
  })
})
