import path from 'node:path'
import { EnvLaneError } from '@env-lane/core'
import type { Command } from 'commander'
import {
  applyRestorePlan,
  buildDefaultRestoreDecisions,
  buildRestorePlan,
  createApprovalDocument,
  hasUnresolvedSelectedConflict,
  readApprovalDocument,
  selectRestorePlan,
  selectRestorePlanByDecisions,
  writeApprovalDocument,
} from '../application/restore.js'
import type { RestoreDecision } from '../domain/types.js'
import { applyRestoreFailOn, emitPlanDiagnostics, emitUnsafeWarning } from './common.js'
import {
  addFailOnOption,
  addRestoreRedactionOption,
  addSelectionOptions,
  assertVaultFormat,
  parseVaultConflictStrategy,
  validateFailOnOption,
} from './options.js'
import { promptRestoreDecisions } from './prompts.js'
import { renderRestorePlan } from './render.js'
import type { VaultCliContext } from './types.js'

function registerVaultPlanCommand(vault: Command, ctx: VaultCliContext): void {
  addRestoreRedactionOption(
    addFailOnOption(addSelectionOptions(ctx.addCommonOptions(vault.command('plan <keyFile>')))),
  )
    .description('Create a verifiable Vault restore plan with configurable preview redaction.')
    .option('--output <file>', 'write an editable approval document')
    .option('--sync-dir <dir>', 'directory containing explicit keyed-fingerprint sync state')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option('--allow-unmanaged', 'allow restoring files not listed in config.envFiles')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      assertVaultFormat(format)
      validateFailOnOption(allOpts.failOn)
      const resolvedConfig = await emitUnsafeWarning(allOpts)
      const plan = await buildRestorePlan(allOpts.config, keyFile, {
        cwd: allOpts.cwd,
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        autoRemapPaths: allOpts.autoRemap,
        allowUnmanaged: allOpts.allowUnmanaged,
        resolvedConfig,
      })
      emitPlanDiagnostics(plan)
      if (allOpts.output) {
        writeApprovalDocument(
          path.resolve(allOpts.cwd, allOpts.output),
          createApprovalDocument(plan, allOpts),
        )
      }
      const selectedPlan = selectRestorePlan(plan, allOpts)
      ctx.formatAndLog(selectedPlan, { format, text: (result) => renderRestorePlan(ctx, result) })
      applyRestoreFailOn(selectedPlan, allOpts.failOn)
    })
}

function registerVaultDecryptCommand(vault: Command, ctx: VaultCliContext): void {
  addRestoreRedactionOption(
    addFailOnOption(addSelectionOptions(ctx.addCommonOptions(vault.command('decrypt <keyFile>')))),
  )
    .option('--dry-run', 'show the restore plan without writing files')
    .option('-y, --yes', 'apply the selected entries without confirmation')
    .option('--sync-dir <dir>', 'directory containing explicit keyed-fingerprint sync state')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option('--allow-unmanaged', 'allow restoring files not listed in config.envFiles')
    .option('--prompt-loop', 'wrap interactive selection from the last entry to the first')
    .option('--no-prompt-loop', 'stop interactive selection at the first and last entries')
    .option('--conflicts <mode>', 'abort, keep-local, or take-vault', 'abort')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      assertVaultFormat(format)
      validateFailOnOption(allOpts.failOn)
      const resolvedConfig = await emitUnsafeWarning(allOpts)
      const plan = await buildRestorePlan(allOpts.config, keyFile, {
        cwd: allOpts.cwd,
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        autoRemapPaths: allOpts.autoRemap,
        allowUnmanaged: allOpts.allowUnmanaged,
        resolvedConfig,
      })
      emitPlanDiagnostics(plan)
      if (allOpts.dryRun) {
        const selectedPlan = selectRestorePlan(plan, allOpts)
        ctx.formatAndLog(selectedPlan, {
          format,
          text: (result) => renderRestorePlan(ctx, result),
        })
        applyRestoreFailOn(selectedPlan, allOpts.failOn)
        return
      }

      let decisions: RestoreDecision[]
      if (allOpts.yes) {
        const strategy = parseVaultConflictStrategy(allOpts.conflicts)
        decisions = buildDefaultRestoreDecisions(plan, allOpts, strategy)
        if (hasUnresolvedSelectedConflict(plan, decisions, allOpts)) {
          throw new EnvLaneError(
            'VAULT_CONFLICT_DECISION_REQUIRED',
            'Selected conflicts require --conflicts keep-local or --conflicts take-vault.',
          )
        }
      } else {
        if (allOpts.nonInteractive) {
          throw new EnvLaneError(
            'VAULT_CONFIRMATION_REQUIRED',
            'Non-interactive restore requires --yes.',
          )
        }
        decisions = await promptRestoreDecisions(plan, allOpts, {
          loop: resolvedConfig.restore.promptLoop,
          redaction: resolvedConfig.restore.redaction,
          reveal: resolvedConfig.restore.reveal,
        })
      }

      const result = await applyRestorePlan(allOpts.config, keyFile, plan, {
        cwd: allOpts.cwd,
        autoApprove: true,
        decisions,
        approveDeletes: allOpts.approveDeletes,
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        autoRemapPaths: allOpts.autoRemap,
        allowUnmanaged: allOpts.allowUnmanaged,
        resolvedConfig,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          ctx.output(`Decrypted ${res.filesWritten} files from ${res.storePath}`)
          ctx.output(`  Applied entries: ${res.appliedEntries}`)
          ctx.output(`  Skipped entries: ${res.skippedEntries}`)
        },
      })
      applyRestoreFailOn(selectRestorePlanByDecisions(result, result.decisions), allOpts.failOn)
    })
}

function registerVaultApplyCommand(vault: Command, ctx: VaultCliContext): void {
  addRestoreRedactionOption(addFailOnOption(ctx.addCommonOptions(vault.command('apply <keyFile>'))))
    .requiredOption('--plan <file>', 'approval document created by vault plan --output')
    .requiredOption('-y, --yes', 'apply the approval document')
    .option('--sync-dir <dir>', 'directory containing explicit keyed-fingerprint sync state')
    .option('--vault-config <file>', 'vault configuration file')
    .option('--no-auto-remap', 'disable automatic remapping of workspace paths')
    .option('--allow-unmanaged', 'allow restoring files not listed in config.envFiles')
    .action(async (keyFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      assertVaultFormat(format)
      validateFailOnOption(allOpts.failOn)
      const resolvedConfig = await emitUnsafeWarning(allOpts)
      if (!allOpts.plan) throw new EnvLaneError('VAULT_PLAN_REQUIRED', 'Missing --plan file.')
      const document = readApprovalDocument(path.resolve(allOpts.cwd, allOpts.plan))
      const result = await applyRestorePlan(allOpts.config, keyFile, document.plan, {
        cwd: allOpts.cwd,
        autoApprove: true,
        decisions: document.decisions,
        syncDir: allOpts.syncDir,
        vaultConfigFile: allOpts.vaultConfig,
        autoRemapPaths: allOpts.autoRemap,
        allowUnmanaged: allOpts.allowUnmanaged,
        resolvedConfig,
      })
      emitPlanDiagnostics(result)
      ctx.formatAndLog(result, {
        format,
        text: (res) =>
          ctx.output(`Applied ${res.appliedEntries} entries to ${res.filesWritten} files.`),
      })
      applyRestoreFailOn(selectRestorePlanByDecisions(result, result.decisions), allOpts.failOn)
    })
}

export function registerVaultRestoreCommands(vault: Command, ctx: VaultCliContext): void {
  registerVaultPlanCommand(vault, ctx)
  registerVaultDecryptCommand(vault, ctx)
  registerVaultApplyCommand(vault, ctx)
}
