import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnvLaneConfig } from '../adapters/config.js'
import { callNativeCore } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
import { EnvLaneError } from '../domain/errors.js'

type SortOperationAction =
  | 'move'
  | 'insert-commented'
  | 'append-extra'
  | 'append-duplicate'
  | 'group-duplicate'

interface SortSummary {
  movedCount: number
  insertedCommentedCount: number
  appendedExtraCount: number
  appendedDuplicateCount: number
  groupedDuplicateCount: number
}

interface SortFileOptions {
  cwd?: string
  create?: boolean
  check?: boolean
  preserveBOM?: boolean
  eol?: 'auto' | 'lf' | 'crlf'
  unlistedVariablesComment?: string
}

type SortConfigOptions = Omit<SortFileOptions, 'unlistedVariablesComment'>

export type SortFileResult = SortSummary & {
  applied: boolean
  changed: boolean
  filePath: string
  templateFilePath: string
  operations: Array<{ action: SortOperationAction; key: string }>
}

export interface ConfiguredSortResult {
  applied: boolean
  changed: boolean
  count: number
  results: SortFileResult[]
}

/** Sort one dotenv file using its template, or preview changes with `check`. */
export async function sortEnvFile(
  file: string,
  template: string,
  options?: SortFileOptions,
): Promise<SortFileResult> {
  const cwd = resolveInvocationCwd(options?.cwd)
  return callNativeCore<SortFileResult>('core.sortEnvFile', {
    cwd,
    file,
    template,
    options: {
      create: options?.create,
      check: options?.check,
      preserveBOM: options?.preserveBOM,
      eol: options?.eol,
      unlistedVariablesComment: options?.unlistedVariablesComment,
    },
  })
}

/** Expand configured sort targets and apply each destination at most once. */
export async function sortEnvFilesFromConfig(
  configPath?: string,
  key = 'all',
  envSuffix = 'all',
  options?: SortConfigOptions,
): Promise<ConfiguredSortResult> {
  const cwd = resolveInvocationCwd(options?.cwd)
  const configFile = configPath ? path.resolve(cwd, configPath) : undefined
  if (configFile && !existsSync(configFile)) {
    throw new EnvLaneError('SORT_CONFIG_NOT_FOUND', `Sort config does not exist: ${configFile}`)
  }
  const discoveryCwd = options?.cwd === undefined && configFile ? path.dirname(configFile) : cwd
  const config = await loadEnvLaneConfig({ cwd: discoveryCwd, configFile })
  return callNativeCore<ConfiguredSortResult>('core.sortEnvFilesFromConfig', {
    cwd: discoveryCwd,
    configFile,
    config,
    key,
    envSuffix,
    create: options?.create,
    check: options?.check,
    preserveBOM: options?.preserveBOM,
    eol: options?.eol,
  })
}
