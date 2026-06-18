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

export function createCliContext(program: Command, consola: ConsolaInstance): CliContext {
  return {
    addCommonOptions(command) {
      return command
        .option('-c, --config <file>', 'env-lane config file')
        .option('-b, --build <name>', 'build selector value')
        .option('--cwd <dir>', 'working directory')
        .option('--format <format>', 'output format (text, json, dotenv)')
        .option('--json', 'use json output format (shorthand for --format json)')
        .option('--no-prefix', 'do not include log prefixes ([env-lane], [env-lane:vault])')
    },
    getGlobalOptions() {
      return program.opts()
    },
    async resolveOutputFormat(opts) {
      let format: EnvLaneOutputFormat
      const config = await loadEnvLaneConfig({ configFile: opts.config, cwd: opts.cwd })

      if (opts.json) {
        format = 'json'
      } else if (opts.format) {
        format = opts.format as EnvLaneOutputFormat
      } else {
        format = config.output.format
      }

      if (format !== 'text' && format !== 'json' && format !== 'dotenv') {
        throw new Error('--format must be one of: text, json, dotenv')
      }

      // Determine if prefix should be enabled
      const prefixEnabled = opts.prefix !== false && config.output.prefix !== false
      const { setPrefixEnabled } = await import('@env-lane/core')
      setPrefixEnabled(prefixEnabled)

      if (format === 'json') consola.level = 2
      return format
    },
    mergeOptions(opts) {
      return { ...program.opts(), ...opts }
    },
    formatAndLog(result, options) {
      if (options.format === 'json') {
        const payload = options.json ? options.json(result) : result
        consola.log(JSON.stringify(payload, null, 2))
      } else if (options.format === 'dotenv' && options.dotenv) {
        options.dotenv(result)
      } else {
        options.text(result)
      }
    },
  }
}
