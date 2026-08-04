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
    preview: { current: `current-${key}`, vault: `vault-${key}` },
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
  let stderrRows: number | undefined

  beforeEach(() => {
    stdinTTY = process.stdin.isTTY
    stderrTTY = process.stderr.isTTY
    stderrRows = process.stderr.rows
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
    promptMocks.checkbox.mockReset()
    promptMocks.confirm.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true })
    Object.defineProperty(process.stderr, 'isTTY', { value: stderrTTY, configurable: true })
    Object.defineProperty(process.stderr, 'rows', { value: stderrRows, configurable: true })
  })

  it('checks deletes by default and maps manually unselected conflicts to keep-local', async () => {
    const deletion = entry('delete', 'DELETE_ME')
    const conflict = entry('conflict', 'MUCH_LONGER_CONFLICT_KEY')
    promptMocks.checkbox.mockResolvedValue([])
    promptMocks.confirm.mockResolvedValue(true)

    await expect(
      promptRestoreDecisions(
        plan([deletion, conflict]),
        {},
        { loop: false, redaction: 'partial', reveal: { start: 4, end: 4 } },
      ),
    ).resolves.toEqual([
      { entryId: deletion.entryId, decision: 'skip' },
      { entryId: conflict.entryId, decision: 'keep-local' },
    ])
    const choices = promptMocks.checkbox.mock.calls[0][0].choices
    expect(promptMocks.checkbox.mock.calls[0][0]).toMatchObject({
      loop: false,
      pageSize: 10,
      message: 'Select Vault entries to apply (preview redaction: partial, reveal: 4:4)',
      instructions: expect.stringContaining('esc/q cancel'),
    })
    const deleteChoice = choices.find(
      (choice: { value?: string }) => choice.value === deletion.entryId,
    )
    expect(deleteChoice).toMatchObject({
      checked: true,
      name: 'delete   DELETE_ME                 current-DELETE_ME → vault-DELETE_ME',
      short: 'delete DELETE_ME',
    })
    expect(deleteChoice.name.indexOf('current-')).toBe(
      choices
        .find((choice: { value?: string }) => choice.value === conflict.entryId)
        .name.indexOf('current-'),
    )
  })

  it('handles an empty plan without inventing decisions', async () => {
    await expect(promptRestoreDecisions(plan([]), {})).resolves.toEqual([])
    expect(promptMocks.checkbox).not.toHaveBeenCalled()
    expect(promptMocks.confirm).not.toHaveBeenCalled()
  })

  it('reduces the ten-line page size when the terminal is too short', async () => {
    Object.defineProperty(process.stderr, 'rows', { value: 8, configurable: true })
    promptMocks.checkbox.mockResolvedValue([])
    promptMocks.confirm.mockResolvedValue(true)

    await promptRestoreDecisions(plan([entry('modify', 'A')]), {})

    expect(promptMocks.checkbox.mock.calls[0][0].pageSize).toBe(4)
  })

  it('truncates displayed keys to 64 characters without changing their entry ids', async () => {
    const longKey = 'A'.repeat(80)
    const longEntry = entry('modify', longKey)
    longEntry.preview = { current: 'before-value', vault: 'vault-value' }
    promptMocks.checkbox.mockResolvedValue([longEntry.entryId])
    promptMocks.confirm.mockResolvedValue(true)

    await expect(promptRestoreDecisions(plan([longEntry]), {})).resolves.toEqual([
      { entryId: longEntry.entryId, decision: 'apply-vault' },
    ])

    const choice = promptMocks.checkbox.mock.calls[0][0].choices[1]
    const visibleKey = `${'A'.repeat(63)}…`
    expect(choice).toMatchObject({
      value: longEntry.entryId,
      name: `modify   ${visibleKey}  before-value → vault-value`,
      short: `modify ${visibleKey}`,
    })
  })

  it.each(['q', 'escape'])('allows %s to cancel selection without Ctrl+C', async (keyName) => {
    const listenerCount = process.stdin.listenerCount('keypress')
    promptMocks.checkbox.mockImplementationOnce(
      (_config: unknown, context: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('cancelled'), { name: 'AbortPromptError' }))
          })
          queueMicrotask(() => {
            process.stdin.emit('keypress', keyName === 'q' ? 'q' : undefined, { name: keyName })
          })
        }),
    )

    await expect(promptRestoreDecisions(plan([entry('modify', 'A')]), {})).rejects.toMatchObject({
      code: 'VAULT_CANCELLED',
    })
    expect(process.stdin.listenerCount('keypress')).toBe(listenerCount)
    expect(promptMocks.confirm).not.toHaveBeenCalled()
  })

  it('turns prompt cancellation into a stable Vault cancellation error', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'ExitPromptError' })
    promptMocks.confirm.mockRejectedValue(cancellation)
    await expect(promptStoreRewrite('Rewrite?')).rejects.toMatchObject({
      code: 'VAULT_CANCELLED',
    })
  })
})
