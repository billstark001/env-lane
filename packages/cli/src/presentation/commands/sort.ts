import { EnvLaneError, sortEnvFile, sortEnvFilesFromConfig } from '@env-lane/core'
import type { Command } from 'commander'
import type { CliContext } from '../runtime/context.js'

export function registerSortCommands(program: Command, ctx: CliContext): void {
  ctx
    .addCommonOptions(program.command('sort-file <envFile> <templateFile>'))
    .description('Sort one env file using a template env file.')
    .option('--eol <format>', 'EOL format for the sorted file (lf, crlf, auto)')
    .option('--no-preserve-bom', 'Remove UTF-8 BOM if present')
    .action(async (envFile, templateFile, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      if (format === 'dotenv') {
        throw new EnvLaneError(
          'UNSUPPORTED_OUTPUT_FORMAT',
          'Sort commands do not support --format dotenv.',
        )
      }
      const result = await sortEnvFile(envFile, templateFile, {
        cwd: allOpts.cwd,
        preserveBOM: allOpts.preserveBom,
        eol: allOpts.eol,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          ctx.output(`${res.applied ? 'Sorted' : 'No changes for'} ${envFile}`)
          if (res.applied) {
            ctx.output(`  Moved: ${res.movedCount}`)
            ctx.output(`  Inserted commented: ${res.insertedCommentedCount}`)
          }
        },
      })
    })

  ctx
    .addCommonOptions(program.command('sort [key] [envSuffix]'))
    .description('Sort env files using an env-lane config sort section.')
    .option('--eol <format>', 'EOL format for the sorted files (lf, crlf, auto)')
    .option('--no-preserve-bom', 'Remove UTF-8 BOM if present')
    .action(async (key = 'all', envSuffix = 'all', opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      if (format === 'dotenv') {
        throw new EnvLaneError(
          'UNSUPPORTED_OUTPUT_FORMAT',
          'Sort commands do not support --format dotenv.',
        )
      }
      const result = await sortEnvFilesFromConfig(allOpts.config, key, envSuffix, {
        cwd: allOpts.cwd,
        preserveBOM: allOpts.preserveBom,
        eol: allOpts.eol,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          ctx.output(`Sort applied: ${res.applied}`)
          for (const r of res.results) {
            ctx.output(`${r.applied ? 'SORTED ' : 'SKIPPED'} ${r.filePath}`)
          }
        },
      })
    })
}
