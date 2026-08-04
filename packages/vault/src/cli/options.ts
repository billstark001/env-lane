import { EnvLaneError, type EnvLaneOutputFormat } from '@env-lane/core'
import type { Command } from 'commander'
import { parseVaultFailCondition } from '../application/restore.js'
import type {
  VaultConflictStrategy,
  VaultMissingFileStrategy,
  VaultRestoreRedaction,
  VaultRestoreReveal,
} from '../domain/types.js'

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

export function parseVaultMissingFileStrategy(
  value: string | undefined,
): VaultMissingFileStrategy | undefined {
  if (value === undefined) return undefined
  if (value === 'delete' || value === 'skip') return value
  throw new EnvLaneError(
    'VAULT_INVALID_MISSING_FILE_STRATEGY',
    '--missing-files must be one of: delete, skip',
  )
}

export function parseVaultRestoreRedaction(
  value: string | undefined,
): VaultRestoreRedaction | undefined {
  if (value === undefined) return undefined
  if (value === 'full' || value === 'partial' || value === 'none') return value
  throw new EnvLaneError(
    'VAULT_INVALID_REDACTION',
    '--redaction must be one of: full, partial, none',
  )
}

export function addRestoreRedactionOption(command: Command): Command {
  return command
    .option('--redaction <mode>', 'restore preview redaction: full, partial, or none')
    .option('--reveal <start:end>', 'show this many leading and trailing characters when redacting')
    .option('--no-reveal', 'do not show leading or trailing characters when redacting')
}

export function parseVaultRestoreReveal(
  value: string | boolean | undefined,
): VaultRestoreReveal | false | undefined {
  if (value === undefined || value === false) return value
  const match = /^(\d+):(\d+)$/.exec(typeof value === 'string' ? value : '')
  const start = Number(match?.[1])
  const end = Number(match?.[2])
  if (!match || start > 64 || end > 64) {
    throw new EnvLaneError(
      'VAULT_INVALID_REVEAL',
      '--reveal must use start:end counts between 0 and 64, for example: --reveal 4:4',
    )
  }
  return { start, end }
}

export function addSelectionOptions(command: Command): Command {
  return command
    .option('--file <glob>', 'select entries whose file path matches this glob')
    .option('--key <glob>', 'select entries whose key matches this glob')
    .option('--include <glob>', 'select entries matching a file:key glob')
    .option('--exclude <glob>', 'exclude entries matching a file:key glob')
    .option('--only <actions>', 'select comma-separated actions: add,modify,delete,conflict')
    .option('--approve-deletes', 'select delete entries (default)', true)
    .option('--no-approve-deletes', 'skip delete entries unless explicitly selected in a plan')
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
