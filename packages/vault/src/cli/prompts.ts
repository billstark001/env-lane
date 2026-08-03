import { EnvLaneError } from '@env-lane/core'
import { checkbox, confirm, Separator } from '@inquirer/prompts'
import { matchesVaultSelection, type VaultSelectionOptions } from '../selection.js'
import type { RestoreDecision, RestorePlan } from '../store.js'

function assertInteractive(): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new EnvLaneError(
      'NON_INTERACTIVE_INPUT',
      'An interactive terminal is required. Re-run with --non-interactive --yes and explicit policies.',
    )
  }
}

function rethrowPromptError(error: unknown): never {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    throw new EnvLaneError('VAULT_CANCELLED', 'Vault operation cancelled. No files were changed.')
  }
  throw error
}

export async function promptRestoreDecisions(
  plan: RestorePlan,
  options: VaultSelectionOptions,
): Promise<RestoreDecision[]> {
  assertInteractive()
  const entries = plan.files
    .flatMap((file) => file.entries)
    .filter((entry) => entry.action !== 'identical' && matchesVaultSelection(entry, options))
  const choices: Array<
    | Separator
    | {
        value: string
        name: string
        checked: boolean
        description?: string
      }
  > = []
  let currentFile = ''
  for (const entry of entries) {
    if (entry.filePath !== currentFile) {
      currentFile = entry.filePath
      choices.push(new Separator(currentFile))
    }
    choices.push({
      value: entry.entryId,
      name: `${entry.action.padEnd(8)} ${entry.key}`,
      checked:
        entry.action !== 'conflict' &&
        (entry.action !== 'delete' || Boolean(options.approveDeletes)),
      description: `${entry.preview.current} -> ${entry.preview.vault}`,
    })
  }

  try {
    const selected = new Set(
      await checkbox(
        {
          message: 'Select Vault entries to apply (values are redacted)',
          choices,
          instructions: true,
          shortcuts: { all: 'a', invert: 'i' },
        },
        { input: process.stdin, output: process.stderr },
      ),
    )
    const approved = await confirm(
      { message: `Apply ${selected.size} selected entries?`, default: false },
      { input: process.stdin, output: process.stderr },
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
