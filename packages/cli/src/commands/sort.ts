import { getLogger, sortEnvFile, sortEnvFilesFromConfig } from '@env-lane/core'
import type { Command } from 'commander'
import type { CliContext } from '../context.js'

function mergedOptions(ctx: CliContext, opts: Record<string, unknown>) {
  return { ...ctx.getGlobalOptions(), ...opts } as Record<string, any>
}

export function registerSortCommands(program: Command, ctx: CliContext): void {
  ctx
    .addCommonOptions(program.command('sort-file <envFile> <templateFile>'))
    .description('Sort one env file using a template env file.')
    .action(async (envFile, templateFile, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await sortEnvFile(envFile, templateFile)
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(`${result.applied ? 'Sorted' : 'No changes for'} ${envFile}`)
        if (result.applied) {
          getLogger().log(`  Moved: ${result.movedCount}`)
          getLogger().log(`  Inserted commented: ${result.insertedCommentedCount}`)
        }
      }
    })

  ctx
    .addCommonOptions(program.command('sort <config> [key] [envSuffix]'))
    .description('Sort env files using an env-lane config sort section.')
    .action(async (config, key = 'all', envSuffix = 'all', opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await sortEnvFilesFromConfig(config, key, envSuffix)
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(`Sort applied: ${result.applied}`)
        for (const r of result.results) {
          getLogger().log(`${r.applied ? 'SORTED ' : 'SKIPPED'} ${r.filePath}`)
        }
      }
    })
}
