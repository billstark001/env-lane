import { type EnvLaneOutputFormat, getLogger } from '@env-lane/core'
import type { Command } from 'commander'
import { buildRestorePlan, decryptEnvFiles, encryptEnvFiles, pruneVaultHistory } from './store.js'

export interface VaultCliContext {
  addCommonOptions(command: Command): Command
  getGlobalOptions(): Record<string, unknown>
  resolveOutputFormat(opts: {
    format?: string
    json?: boolean
    config?: string
    cwd?: string
  }): Promise<EnvLaneOutputFormat>
}

function mergedOptions(ctx: VaultCliContext, opts: Record<string, unknown>) {
  return { ...ctx.getGlobalOptions(), ...opts } as Record<string, any>
}

function parseVaultConflictStrategy(value: string | undefined) {
  if (value === undefined) return undefined
  if (value === 'ask' || value === 'overwrite' || value === 'ignore') return value
  throw new Error('--conflicts must be one of: ask, overwrite, ignore')
}

export function registerVaultCommands(program: Command, ctx: VaultCliContext): void {
  const vault = program
    .command('vault')
    .description('Optional unsafe development vault helpers. Requires @env-lane/vault.')

  ctx
    .addCommonOptions(vault.command('encrypt <config> <keyFile>'))
    .option('--sync-dir <dir>', 'enable local vault sync state in the manually specified directory')
    .option(
      '--conflicts <mode>',
      'when --sync-dir detects a conflict: ask, overwrite, or ignore',
      'ask',
    )
    .action(async (config, keyFile, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await encryptEnvFiles(config, keyFile, {
        syncDir: allOpts.syncDir,
        conflictStrategy: parseVaultConflictStrategy(allOpts.conflicts),
      })
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(`Encrypted records to ${result.storePath}`)
        getLogger().log(`  Set: ${result.setRecordsWritten}`)
        getLogger().log(`  Delete: ${result.deleteRecordsWritten}`)
        getLogger().log(`  Skipped unchanged: ${result.skippedUnchanged}`)
        if (result.conflicts > 0) {
          getLogger().log(`  Conflicts: ${result.conflicts}`)
          getLogger().log(`  Conflicts overwritten: ${result.conflictsOverwritten}`)
          getLogger().log(`  Conflicts ignored: ${result.conflictsIgnored}`)
        }
        if (result.syncStatePath) getLogger().log(`  Sync state: ${result.syncStatePath}`)
      }
    })

  ctx
    .addCommonOptions(vault.command('plan <config> <keyFile>'))
    .description('Print the vault restore plan without writing files.')
    .option('--sync-dir <dir>', 'include local vault sync-state conflict detection')
    .action(async (config, keyFile, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await buildRestorePlan(config, keyFile, { syncDir: allOpts.syncDir })
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(`Restore plan for ${result.storePath}:`)
        for (const file of result.files) {
          const changes = file.entries.filter((e) => e.action !== 'identical')
          if (changes.length > 0) {
            getLogger().log(`# ${file.filePath}`)
            for (const e of changes) getLogger().log(`  ${e.action.padEnd(10)} ${e.key}`)
          }
        }
        getLogger().log(
          `Summary: ${result.summary.filesWithChanges} files to change, ${result.summary.conflict} conflicts.`,
        )
      }
    })

  ctx
    .addCommonOptions(vault.command('decrypt <config> <keyFile>'))
    .option('--dry-run', 'show planned restore without writing files')
    .option('-y, --yes', 'apply restore without interactive confirmation')
    .option('--sync-dir <dir>', 'enable local vault sync state in the manually specified directory')
    .option(
      '--conflicts <mode>',
      'when --sync-dir detects a conflict: ask, overwrite, or ignore',
      'ask',
    )
    .action(async (config, keyFile, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await decryptEnvFiles(config, keyFile, {
        dryRun: allOpts.dryRun,
        autoApprove: allOpts.yes,
        syncDir: allOpts.syncDir,
        conflictStrategy: parseVaultConflictStrategy(allOpts.conflicts),
      })
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(`Decrypted ${result.filesWritten} files from ${result.storePath}`)
        if ('conflictsIgnored' in result && result.conflictsIgnored) {
          getLogger().log(`  Conflicts ignored: ${result.conflictsIgnored}`)
        }
        if ('syncStatePath' in result && result.syncStatePath) {
          getLogger().log(`  Sync state: ${result.syncStatePath}`)
        }
      }
    })

  ctx
    .addCommonOptions(vault.command('prune <config> <keyFile>'))
    .description('Prune old vault history while preserving the latest record for each key.')
    .option('--file <path>', 'only prune history for one env file from the vault config')
    .option('--key <name>', 'only prune history for one env key')
    .option('--older-than-days <days>', 'remove history records older than this many days')
    .option('--keep-recent <count>', 'keep only this many recent history records per file/key')
    .option(
      '--no-preserve-latest',
      'allow pruning the latest record when it matches the prune rule',
    )
    .option('--dry-run', 'show how many records would be removed without rewriting the store')
    .option('-y, --yes', 'rewrite the vault store without interactive confirmation')
    .action(async (config, keyFile, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await pruneVaultHistory(config, keyFile, {
        filePath: allOpts.file,
        key: allOpts.key,
        olderThanDays:
          allOpts.olderThanDays === undefined ? undefined : Number(allOpts.olderThanDays),
        keepRecent: allOpts.keepRecent === undefined ? undefined : Number(allOpts.keepRecent),
        preserveLatest: allOpts.preserveLatest,
        dryRun: allOpts.dryRun,
        autoApprove: allOpts.yes,
      })
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(
          `${result.applied ? 'Pruned' : 'Would prune'} ${result.removedRecords} records from ${result.storePath}`,
        )
        getLogger().log(`  Kept: ${result.keptRecords}`)
        getLogger().log(`  Groups: ${result.groups}`)
      }
    })
}
