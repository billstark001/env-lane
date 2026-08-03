import { EnvLaneError } from '@env-lane/core'
import type { Command } from 'commander'
import { pruneVaultHistory, sanitizeVaultHistory } from '../application/storage.js'
import { emitUnsafeWarning } from './common.js'
import { assertVaultFormat } from './options.js'
import { promptStoreRewrite } from './prompts.js'
import type { VaultCliContext, VaultCommandOptions } from './types.js'

function assertCanPrompt(opts: VaultCommandOptions, operation: string): void {
  if (opts.nonInteractive && !opts.yes && !opts.dryRun) {
    throw new EnvLaneError('VAULT_CONFIRMATION_REQUIRED', `${operation} requires --yes.`)
  }
}

export function registerVaultHistoryCommands(vault: Command, ctx: VaultCliContext): void {
  ctx
    .addCommonOptions(vault.command('sanitize <keyFile>'))
    .description('Remove all historical records matched by local-only exclude rules.')
    .requiredOption('--excluded', 'sanitize every record matched by configured exclude rules')
    .option('--dry-run', 'show excluded history without rewriting the store')
    .option('-y, --yes', 'rewrite the vault store without interactive confirmation')
    .option('--vault-config <file>', 'vault configuration file')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      assertVaultFormat(format)
      const resolvedConfig = await emitUnsafeWarning(allOpts)
      const operationOptions = {
        cwd: allOpts.cwd,
        excluded: allOpts.excluded,
        vaultConfigFile: allOpts.vaultConfig,
        resolvedConfig,
      }
      assertCanPrompt(allOpts, 'Vault sanitize')
      const preview = await sanitizeVaultHistory(allOpts.config, keyFile, {
        ...operationOptions,
        dryRun: true,
      })
      const approved =
        !allOpts.dryRun &&
        (Boolean(allOpts.yes) ||
          (await promptStoreRewrite(
            `Remove ${preview.removedRecords} record(s) from ${preview.storePath}?`,
          )))
      const result = approved
        ? await sanitizeVaultHistory(allOpts.config, keyFile, {
            ...operationOptions,
            autoApprove: true,
            expectedStoreDigest: preview.storeDigest,
          })
        : preview
      ctx.formatAndLog(result, {
        format,
        text: (res) =>
          ctx.output(
            `${res.applied ? 'Sanitized' : 'Would sanitize'} ${res.removedRecords} records from ${res.storePath}`,
          ),
      })
    })

  ctx
    .addCommonOptions(vault.command('prune <keyFile>'))
    .description('Prune old Vault history while preserving the latest record for each key.')
    .option('--file <path>', 'only prune history for one env file')
    .option('--key <name>', 'only prune history for one env key')
    .option('--older-than-days <days>', 'remove history records older than this many days')
    .option('--keep-recent <count>', 'keep this many recent history records per file/key')
    .option('--no-preserve-latest', 'allow pruning the latest matching record')
    .option('--dry-run', 'preview without rewriting the store')
    .option('-y, --yes', 'rewrite the vault store without interactive confirmation')
    .option('--vault-config <file>', 'vault configuration file')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      assertVaultFormat(format)
      const resolvedConfig = await emitUnsafeWarning(allOpts)
      const operationOptions = {
        cwd: allOpts.cwd,
        filePath: allOpts.file,
        key: allOpts.key,
        olderThanDays:
          allOpts.olderThanDays === undefined ? undefined : Number(allOpts.olderThanDays),
        keepRecent: allOpts.keepRecent === undefined ? undefined : Number(allOpts.keepRecent),
        preserveLatest: allOpts.preserveLatest,
        vaultConfigFile: allOpts.vaultConfig,
        resolvedConfig,
      }
      assertCanPrompt(allOpts, 'Vault history prune')
      const preview = await pruneVaultHistory(allOpts.config, keyFile, {
        ...operationOptions,
        dryRun: true,
      })
      const approved =
        !allOpts.dryRun &&
        (Boolean(allOpts.yes) ||
          (await promptStoreRewrite(
            `Remove ${preview.removedRecords} record(s) from ${preview.storePath}?`,
          )))
      const result = approved
        ? await pruneVaultHistory(allOpts.config, keyFile, {
            ...operationOptions,
            autoApprove: true,
            expectedStoreDigest: preview.storeDigest,
          })
        : preview
      ctx.formatAndLog(result, {
        format,
        text: (res) =>
          ctx.output(
            `${res.applied ? 'Pruned' : 'Would prune'} ${res.removedRecords} records from ${res.storePath}`,
          ),
      })
    })
}
