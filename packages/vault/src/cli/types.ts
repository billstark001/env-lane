import type { DiagnosticLogger, EnvLaneOutputFormat } from '@env-lane/core'
import type { Command } from 'commander'

export interface VaultCommandOptions extends Record<string, unknown> {
  config?: string
  build?: string
  cwd: string
  format?: string
  json?: boolean
  nonInteractive?: boolean
  prefix?: boolean
  vaultConfig?: string
  syncDir?: string
  autoRemap?: boolean
  allowUnmanaged?: boolean
  conflicts?: string
  failOn?: string
  file?: string
  key?: string
  include?: string
  exclude?: string
  only?: string
  approveDeletes?: boolean
  dryRun?: boolean
  yes?: boolean
  excluded?: boolean
  plan?: string
  output?: string
  olderThanDays?: string
  keepRecent?: string
  preserveLatest?: boolean
}

export interface VaultCliContext {
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
  mergeOptions(opts: Record<string, unknown>): VaultCommandOptions
  output(message: string): void
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
