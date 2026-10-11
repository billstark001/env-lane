import path from 'node:path'
import { EnvLaneError } from '@env-lane/core'
import { checkbox, confirm, Separator } from '@inquirer/prompts'
import { createVaultSelectionMatcher, type VaultSelectionOptions } from '../application/restore.js'
import type {
  RestoreDecision,
  RestorePlan,
  VaultRestoreRedaction,
  VaultRestoreReveal,
} from '../domain/types.js'
import { inline, variableGroups } from './render.js'

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
const RESTORE_PROMPT_RESERVED_ROWS = 6

function restorePromptPageSize(rows = process.stderr.rows): number {
  if (!Number.isInteger(rows) || !rows || rows <= 0) return RESTORE_PROMPT_PAGE_SIZE
  return Math.max(1, Math.min(RESTORE_PROMPT_PAGE_SIZE, rows - RESTORE_PROMPT_RESERVED_ROWS))
}

export async function promptRestoreDecisions(
  plan: RestorePlan,
  options: VaultSelectionOptions,
  display: {
    root?: string
    loop?: boolean
    redaction?: VaultRestoreRedaction
    reveal?: VaultRestoreReveal | false
  } = {},
): Promise<RestoreDecision[]> {
  const selected = createVaultSelectionMatcher(options)
  const entries = plan.files
    .flatMap((file) => file.entries)
    .filter((entry) => entry.action !== 'identical' && selected(entry))
  if (entries.length === 0) return []
  assertInteractive()
  const choices: Array<
    | Separator
    | {
        value: string
        name: string
        short: string
        checked: boolean
        description: string
      }
  > = []
  for (const file of plan.files) {
    const fileEntries = entries.filter((entry) => entry.filePath === file.filePath)
    if (fileEntries.length === 0) continue
    const relative = inline(path.relative(display.root ?? process.cwd(), file.filePath))
    choices.push(new Separator(relative))
    for (const group of variableGroups(fileEntries.map((entry) => entry.key))) {
      if (group.prefix)
        choices.push(new Separator(`  ${inline(group.prefix)} (${group.keys.length})`))
      for (const key of group.keys) {
        for (const entry of fileEntries.filter((entry) => entry.key === key)) {
          choices.push({
            value: entry.entryId,
            name: `${inline(entry.key)} [${entry.action}]`,
            short: `${entry.action} ${inline(entry.key)}`,
            description: `${relative}\nCurrent: ${inline(entry.preview.current)}\nVault: ${inline(entry.preview.vault)}`,
            checked:
              entry.action !== 'conflict' &&
              (entry.action !== 'delete' || options.approveDeletes !== false),
          })
        }
      }
    }
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
