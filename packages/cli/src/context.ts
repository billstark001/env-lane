import type { EnvLaneOutputFormat } from '@env-lane/core'
import { loadEnvLaneConfig } from '@env-lane/core'
import type { Command } from 'commander'
import type { ConsolaInstance } from 'consola'

export interface CliContext {
  addCommonOptions(command: Command): Command
  getGlobalOptions(): Record<string, unknown>
  resolveOutputFormat(opts: {
    format?: string
    json?: boolean
    config?: string
    cwd?: string
  }): Promise<EnvLaneOutputFormat>
}

export function createCliContext(program: Command, consola: ConsolaInstance): CliContext {
  return {
    addCommonOptions(command) {
      return command
        .option('-c, --config <file>', 'env-lane config file')
        .option('-b, --build <name>', 'build selector value')
        .option('--cwd <dir>', 'working directory')
        .option('--format <format>', 'output format (text, json, dotenv)')
        .option('--json', 'use json output format (shorthand for --format json)')
    },
    getGlobalOptions() {
      return program.opts()
    },
    async resolveOutputFormat(opts) {
      let format: EnvLaneOutputFormat
      if (opts.json) {
        format = 'json'
      } else if (opts.format) {
        format = opts.format as EnvLaneOutputFormat
      } else {
        const config = await loadEnvLaneConfig({ configFile: opts.config, cwd: opts.cwd })
        format = config.output.format
      }

      if (format !== 'text' && format !== 'json' && format !== 'dotenv') {
        throw new Error('--format must be one of: text, json, dotenv')
      }
      if (format === 'json') consola.level = 2
      return format
    },
  }
}
