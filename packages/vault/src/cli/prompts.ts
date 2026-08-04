import { EnvLaneError } from '@env-lane/core'
import { checkbox, confirm, Separator } from '@inquirer/prompts'
import { matchesVaultSelection, type VaultSelectionOptions } from '../application/restore.js'
import type {
  RestoreDecision,
  RestorePlan,
  VaultRestoreRedaction,
  VaultRestoreReveal,
} from '../domain/types.js'

function assertInteractive(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new EnvLaneError(
      'NON_INTERACTIVE_INPUT',
      'An interactive terminal is required. Re-run with --non-interactive --yes and explicit policies.',
    )
  }
}

function rethrowPromptError(error: unknown): never {
  if (
    error instanceof Error &&
    (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')
  ) {
    throw new EnvLaneError('VAULT_CANCELLED', 'Vault operation cancelled. No files were changed.')
  }
  throw error
}

const RESTORE_PROMPT_PAGE_SIZE = 10
const RESTORE_PROMPT_RESERVED_ROWS = 4
const RESTORE_PROMPT_KEY_MAX_LENGTH = 64

function restorePromptPageSize(rows = process.stderr.rows): number {
  if (!Number.isInteger(rows) || !rows || rows <= 0) return RESTORE_PROMPT_PAGE_SIZE
  return Math.max(1, Math.min(RESTORE_PROMPT_PAGE_SIZE, rows - RESTORE_PROMPT_RESERVED_ROWS))
}

function inlinePreview(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function displayKey(key: string): string {
  if (key.length <= RESTORE_PROMPT_KEY_MAX_LENGTH) return key
  return `${key.slice(0, RESTORE_PROMPT_KEY_MAX_LENGTH - 1)}…`
}

export async function promptRestoreDecisions(
  plan: RestorePlan,
  options: VaultSelectionOptions,
  display: {
    loop?: boolean
    redaction?: VaultRestoreRedaction
    reveal?: VaultRestoreReveal | false
  } = {},
): Promise<RestoreDecision[]> {
  const entries = plan.files
    .flatMap((file) => file.entries)
    .filter((entry) => entry.action !== 'identical' && matchesVaultSelection(entry, options))
  if (entries.length === 0) return []
  assertInteractive()
  const choices: Array<
    | Separator
    | {
        value: string
        name: string
        short: string
        checked: boolean
      }
  > = []
  const keyColumnWidth = entries.reduce(
    (width, entry) => Math.max(width, Math.min(entry.key.length, RESTORE_PROMPT_KEY_MAX_LENGTH)),
    0,
  )
  let currentFile = ''
  for (const entry of entries) {
    if (entry.filePath !== currentFile) {
      currentFile = entry.filePath
      choices.push(new Separator(currentFile))
    }
    const visibleKey = displayKey(entry.key)
    choices.push({
      value: entry.entryId,
      name: `${entry.action.padEnd(8)} ${visibleKey.padEnd(keyColumnWidth)}  ${inlinePreview(entry.preview.current)} → ${inlinePreview(entry.preview.vault)}`,
      short: `${entry.action} ${visibleKey}`,
      checked:
        entry.action !== 'conflict' &&
        (entry.action !== 'delete' || options.approveDeletes !== false),
    })
  }

  const abortController = new AbortController()
  const cancelOnKeypress = (
    _value: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
  ) => {
    if (key?.name === 'escape' || (key?.name === 'q' && key.ctrl !== true && key.meta !== true)) {
      abortController.abort()
    }
  }
  process.stdin.on('keypress', cancelOnKeypress)

  try {
    const revealLabel = display.reveal
      ? `, reveal: ${display.reveal.start}:${display.reveal.end}`
      : ''
    const selected = new Set(
      await checkbox(
        {
          message: `Select Vault entries to apply (preview redaction: ${display.redaction ?? 'full'}${revealLabel})`,
          choices,
          loop: display.loop ?? false,
          pageSize: restorePromptPageSize(),
          instructions: '↑↓ navigate • space select • a all • i invert • ⏎ submit • esc/q cancel',
          shortcuts: { all: 'a', invert: 'i' },
        },
        { input: process.stdin, output: process.stderr, signal: abortController.signal },
      ),
    )
    const approved = await confirm(
      { message: `Apply ${selected.size} selected entries?`, default: false },
      { input: process.stdin, output: process.stderr, signal: abortController.signal },
    )
    if (!approved) {
      throw new EnvLaneError('VAULT_CANCELLED', 'Vault apply cancelled. No files were changed.')
    }
    return plan.files.flatMap((file) =>
      file.entries
        .filter((entry) => entry.action !== 'identical')
        .map((entry) => ({
          entryId: entry.entryId,
          decision: selected.has(entry.entryId)
            ? ('apply-vault' as const)
            : entry.action === 'conflict'
              ? ('keep-local' as const)
              : ('skip' as const),
        })),
    )
  } catch (error) {
    rethrowPromptError(error)
  } finally {
    process.stdin.removeListener('keypress', cancelOnKeypress)
  }
}

export async function promptStoreRewrite(operation: string): Promise<boolean> {
  assertInteractive()
  try {
    return await confirm(
      { message: operation, default: false },
      { input: process.stdin, output: process.stderr },
    )
  } catch (error) {
    rethrowPromptError(error)
  }
}
