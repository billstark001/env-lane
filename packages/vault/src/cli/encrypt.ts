import type { Command } from 'commander'
import { encryptEnvFiles } from '../application/push.js'
import { matchesVaultPushSelection } from '../application/restore.js'
import { emitUnsafeWarning } from './common.js'
import {
  addFailOnOption,
  addSelectionOptions,
  assertVaultFormat,
  parseVaultConflictStrategy,
  validateFailOnOption,
} from './options.js'
import type { VaultCliContext } from './types.js'

export function registerVaultEncryptCommand(vault: Command, ctx: VaultCliContext): void {
  addFailOnOption(addSelectionOptions(ctx.addCommonOptions(vault.command('encrypt <keyFile>'))))
    .option('--dry-run', 'preview Vault records without writing the store or sync state')
    .option('--sync-dir <dir>', 'directory containing explicit keyed-fingerprint sync state')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option('--conflicts <mode>', 'abort, keep-local, or take-vault', 'abort')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      assertVaultFormat(format)
      validateFailOnOption(allOpts.failOn)
      const resolvedConfig = await emitUnsafeWarning(allOpts)
      const result = await encryptEnvFiles(allOpts.config, keyFile, {
        cwd: allOpts.cwd,
        dryRun: allOpts.dryRun,
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        conflictStrategy: parseVaultConflictStrategy(allOpts.conflicts),
        autoRemapPaths: allOpts.autoRemap,
        selectEntry: (entry) => matchesVaultPushSelection(entry, allOpts),
        resolvedConfig,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          ctx.output(
            `${allOpts.dryRun ? 'Would encrypt records to' : 'Encrypted records to'} ${res.storePath}`,
          )
          ctx.output(`  Set: ${res.setRecordsWritten}`)
          ctx.output(`  Delete: ${res.deleteRecordsWritten}`)
          ctx.output(`  Skipped unchanged: ${res.skippedUnchanged}`)
          ctx.output(`  Skipped by selection: ${res.selectionSkipped}`)
          if (res.conflicts) ctx.output(`  Conflicts: ${res.conflicts}`)
        },
      })
      if (allOpts.failOn === 'conflict' && result.conflicts > 0) process.exitCode = 2
      if (allOpts.failOn === 'change' && result.changes.length > 0) process.exitCode = 2
      if (
        allOpts.failOn === 'warning' &&
        (result.failedRecords > 0 ||
          result.invalidLinesIgnored > 0 ||
          result.missingFilesSkipped > 0 ||
          result.shadowedEntriesIgnored > 0)
      ) {
        process.exitCode = 2
      }
    })
}
