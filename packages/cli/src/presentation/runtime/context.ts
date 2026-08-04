import path from 'node:path'
import {
  type DiagnosticLogger,
  EnvLaneError,
  type EnvLaneOutputFormat,
  errorCode,
  formatDiagnostic,
  loadEnvLaneConfig,
} from '@env-lane/core'
import type { Command } from 'commander'

interface WritableStream {
  write(chunk: string): unknown
}

export interface CliStreams {
  stdout: WritableStream
  stderr: WritableStream
}

export interface CliOptionValues extends Record<string, unknown> {
  config?: string
  build?: string
  cwd: string
  format?: string
  json?: boolean
  nonInteractive?: boolean
  prefix?: boolean
  showSecrets?: boolean
  includeShell?: boolean
  processEnv?: boolean
  requireOverride?: boolean
  runCwd?: 'target' | 'root' | string
  quiet?: boolean
  policy?: string
  target?: string
  dryRun?: boolean
  preserveBom?: boolean
  eol?: 'auto' | 'lf' | 'crlf'
}

export interface CliContext {
  readonly logger: DiagnosticLogger
  addCommonOptions(command: Command): Command
  setDiagnosticPrefix(enabled: boolean): void
  resolveOutputFormat(opts: {
    format?: string
    json?: boolean
    config?: string
    cwd?: string
    prefix?: boolean
  }): Promise<EnvLaneOutputFormat>
  mergeOptions(opts: Record<string, unknown>): CliOptionValues
  output(message: string): void
  renderError(error: unknown, json: boolean): void
  formatAndLog<T>(
    result: T,
    options: {
      format: EnvLaneOutputFormat
      text: (res: T) => void
      dotenv?: (res: T) => void
      json?: (res: T) => unknown
    },
  ): void
}

export function createCliContext(
  program: Command,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
): CliContext {
  let diagnosticPrefixEnabled = true
  const output = (message: string) => streams.stdout.write(`${message}\n`)
  const logger: DiagnosticLogger = {
    diagnostic(event) {
      streams.stderr.write(`${formatDiagnostic(event, { prefix: diagnosticPrefixEnabled })}\n`)
    },
  }

  return {
    logger,
    addCommonOptions(command) {
      return command
        .option('-c, --config <file>', 'env-lane config file')
        .option('-b, --build <name>', 'build selector value')
        .option('--cwd <dir>', 'base directory for config discovery and relative CLI paths')
        .option('--format <format>', 'output format (text, json, dotenv)')
        .option('--json', 'use json output format (shorthand for --format json)')
        .option('--non-interactive', 'disable prompts and require every decision explicitly')
        .option('--no-prefix', 'do not include diagnostic scope prefixes')
    },
    setDiagnosticPrefix(enabled) {
      diagnosticPrefixEnabled = enabled
    },
    async resolveOutputFormat(opts) {
      const config = await loadEnvLaneConfig({ configFile: opts.config, cwd: opts.cwd })
      const format = opts.json
        ? 'json'
        : opts.format
          ? (opts.format as EnvLaneOutputFormat)
          : config.output.format

      if (format !== 'text' && format !== 'json' && format !== 'dotenv') {
        throw new EnvLaneError(
          'INVALID_OUTPUT_FORMAT',
          '--format must be one of: text, json, dotenv',
        )
      }
      diagnosticPrefixEnabled = opts.prefix !== false && config.output.prefix !== false
      return format
    },
    mergeOptions(opts) {
      const rootOptions = program.opts()
      const merged = {
        ...rootOptions,
        ...Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined)),
      }
      if (rootOptions.prefix === false) merged.prefix = false
      return {
        ...merged,
        cwd: path.resolve(typeof merged.cwd === 'string' ? merged.cwd : process.cwd()),
      }
    },
    output,
    renderError(error, json) {
      const message = error instanceof Error ? error.message : String(error)
      const code = errorCode(error)
      if (json) {
        output(
          JSON.stringify(
            {
              ok: false,
              error: {
                code,
                message,
                ...(error instanceof EnvLaneError && error.details
                  ? { details: error.details }
                  : {}),
              },
            },
            null,
            2,
          ),
        )
        return
      }
      logger.diagnostic({
        code,
        level: 'error',
        scope: code.startsWith('VAULT_') ? 'vault' : 'core',
        message,
      })
    },
    formatAndLog(result, options) {
      if (options.format === 'json') {
        output(JSON.stringify(options.json ? options.json(result) : result, null, 2))
      } else if (options.format === 'dotenv') {
        if (!options.dotenv) {
          throw new EnvLaneError(
            'UNSUPPORTED_OUTPUT_FORMAT',
            'The selected command does not support --format dotenv.',
          )
        }
        options.dotenv(result)
      } else {
        options.text(result)
      }
    },
  }
}
