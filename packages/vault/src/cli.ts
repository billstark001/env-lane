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
    prefix?: boolean
  }): Promise<EnvLaneOutputFormat>
  mergeOptions(opts: Record<string, unknown>): Record<string, any>
  formatAndLog<T>(
    result: T,
    options: {
      format: EnvLaneOutputFormat
      text: (res: T) => void
      dotenv?: (res: T) => void
      json?: (res: T) => any
    },
  ): void
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
    .addCommonOptions(vault.command('encrypt <keyFile>'))
    .option('--sync-dir <dir>', 'enable local vault sync state in the manually specified directory')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option(
      '--conflicts <mode>',
      'when --sync-dir detects a conflict: ask, overwrite, or ignore',
      'ask',
    )
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await encryptEnvFiles(allOpts.config, keyFile, {
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        conflictStrategy: parseVaultConflictStrategy(allOpts.conflicts),
        autoRemapPaths: allOpts.autoRemap,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          getLogger().log(`Encrypted records to ${res.storePath}`)
          getLogger().log(`  Set: ${res.setRecordsWritten}`)
          getLogger().log(`  Delete: ${res.deleteRecordsWritten}`)
          getLogger().log(`  Skipped unchanged: ${res.skippedUnchanged}`)
          if (res.conflicts > 0) {
            getLogger().log(`  Conflicts: ${res.conflicts}`)
            getLogger().log(`  Conflicts overwritten: ${res.conflictsOverwritten}`)
            getLogger().log(`  Conflicts ignored: ${res.conflictsIgnored}`)
          }
          if (res.syncStatePath) getLogger().log(`  Sync state: ${res.syncStatePath}`)
        },
      })
    })

  ctx
    .addCommonOptions(vault.command('plan <keyFile>'))
    .description('Print the vault restore plan without writing files.')
    .option('--sync-dir <dir>', 'include local vault sync-state conflict detection')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option('--allow-unmanaged', 'allow restoring files not listed in config.envFiles')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await buildRestorePlan(allOpts.config, keyFile, {
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        autoRemapPaths: allOpts.autoRemap,
        allowUnmanaged: allOpts.allowUnmanaged,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          getLogger().log(`Restore plan for ${res.storePath}:`)
          for (const file of res.files) {
            const changes = file.entries.filter((e) => e.action !== 'identical')
            if (changes.length > 0) {
              getLogger().log(`# ${file.filePath}`)
              for (const e of changes) getLogger().log(`  ${e.action.padEnd(10)} ${e.key}`)
            }
          }
          getLogger().log(
            `Summary: ${res.summary.filesWithChanges} files to change, ${res.summary.conflict} conflicts.`,
          )
        },
      })
    })

  ctx
    .addCommonOptions(vault.command('decrypt <keyFile>'))
    .option('--dry-run', 'show planned restore without writing files')
    .option('-y, --yes', 'apply restore without interactive confirmation')
    .option('--sync-dir <dir>', 'enable local vault sync state in the manually specified directory')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option('--allow-unmanaged', 'allow restoring files not listed in config.envFiles')
    .option(
      '--conflicts <mode>',
      'when --sync-dir detects a conflict: ask, overwrite, or ignore',
      'ask',
    )
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await decryptEnvFiles(allOpts.config, keyFile, {
        dryRun: allOpts.dryRun,
        autoApprove: allOpts.yes,
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        conflictStrategy: parseVaultConflictStrategy(allOpts.conflicts),
        autoRemapPaths: allOpts.autoRemap,
        allowUnmanaged: allOpts.allowUnmanaged,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          getLogger().log(`Decrypted ${res.filesWritten} files from ${res.storePath}`)
          if ('conflictsIgnored' in res && res.conflictsIgnored) {
            getLogger().log(`  Conflicts ignored: ${res.conflictsIgnored}`)
          }
          if ('syncStatePath' in res && res.syncStatePath) {
            getLogger().log(`  Sync state: ${res.syncStatePath}`)
          }
        },
      })
    })

  ctx
    .addCommonOptions(vault.command('prune <keyFile>'))
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
    .option('--vault-config <file>', 'vault configuration file')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await pruneVaultHistory(allOpts.config, keyFile, {
        filePath: allOpts.file,
        key: allOpts.key,
        olderThanDays:
          allOpts.olderThanDays === undefined ? undefined : Number(allOpts.olderThanDays),
        keepRecent: allOpts.keepRecent === undefined ? undefined : Number(allOpts.keepRecent),
        preserveLatest: allOpts.preserveLatest,
        dryRun: allOpts.dryRun,
        autoApprove: allOpts.yes,
        vaultConfigFile: allOpts.vaultConfig,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          getLogger().log(
            `${res.applied ? 'Pruned' : 'Would prune'} ${res.removedRecords} records from ${res.storePath}`,
          )
          getLogger().log(`  Kept: ${res.keptRecords}`)
          getLogger().log(`  Groups: ${res.groups}`)
        },
      })
    })
}
