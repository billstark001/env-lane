import { EnvLaneError, type EnvLaneOutputFormat } from '@env-lane/core'
import type { Command } from 'commander'
import { parseVaultFailCondition } from '../fail-on.js'
import type { VaultConflictStrategy } from '../store.js'

export function assertVaultFormat(format: EnvLaneOutputFormat): void {
  if (format === 'dotenv') {
    throw new EnvLaneError(
      'UNSUPPORTED_OUTPUT_FORMAT',
      'Vault commands do not support --format dotenv.',
    )
  }
}

export function parseVaultConflictStrategy(
  value: string | undefined,
): VaultConflictStrategy | undefined {
  if (value === undefined) return undefined
  if (value === 'abort' || value === 'keep-local' || value === 'take-vault') return value
  throw new EnvLaneError(
    'VAULT_INVALID_CONFLICT_STRATEGY',
    '--conflicts must be one of: abort, keep-local, take-vault',
  )
}

export function addSelectionOptions(command: Command): Command {
  return command
    .option('--file <glob>', 'select entries whose file path matches this glob')
    .option('--key <glob>', 'select entries whose key matches this glob')
    .option('--include <glob>', 'select entries matching a file:key glob')
    .option('--exclude <glob>', 'exclude entries matching a file:key glob')
    .option('--only <actions>', 'select comma-separated actions: add,modify,delete,conflict')
    .option('--approve-deletes', 'allow delete entries to be selected by default')
}

export function addFailOnOption(command: Command): Command {
  return command.option(
    '--fail-on <condition>',
    'exit unsuccessfully when the result contains conflict, change, or warning',
  )
}

export function validateFailOnOption(value: string | undefined): void {
  parseVaultFailCondition(value)
}
