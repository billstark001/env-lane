import path from 'node:path'
import { loadConfig as c12LoadConfig } from 'c12'
import { EnvLaneError } from '../domain/errors.js'
import type { EnvLaneConfig, ResolvedEnvLaneConfig } from '../domain/types.js'
import { callNativeCore } from './native.js'
import {
  type AbsolutePath,
  assertAbsolutePath,
  resolveFromDirectory,
  resolveInvocationCwd,
} from './paths.js'

export function defineConfig(config: EnvLaneConfig): EnvLaneConfig {
  return config
}

export async function findWorkspaceRoot(cwd?: string): Promise<AbsolutePath> {
  const invocationCwd = resolveInvocationCwd(cwd)
  return callNativeCore<AbsolutePath>('core.findWorkspaceRoot', { cwd: invocationCwd })
}

export interface LoadConfigOptionsWithC12 {
  cwd?: string
  configFile?: string
  name: string
  configFileRequired?: boolean
}

export async function loadConfigWithC12<T extends object>(
  options: LoadConfigOptionsWithC12,
): Promise<{ config: T; configFile?: string; rootDir: string }> {
  const resolutionCwd = resolveInvocationCwd(options.cwd)
  const rootDir = await findWorkspaceRoot(resolutionCwd)
  const configFileName = options.configFile
    ? path.relative(rootDir, resolveFromDirectory(resolutionCwd, options.configFile))
    : undefined

  const loaded = await c12LoadConfig<T>({
    name: options.name,
    cwd: rootDir,
    configFile: configFileName,
    packageJson: false,
    dotenv: false,
    rcFile: false,
    globalRc: false,
    configFileRequired: options.configFileRequired ?? false,
  })

  return {
    config: loaded.config as T,
    configFile: loaded.configFile,
    rootDir,
  }
}

async function loadEnvLaneConfigUnchecked(
  options: { cwd?: string; configFile?: string } = {},
): Promise<ResolvedEnvLaneConfig> {
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const { config, configFile, rootDir } = await loadConfigWithC12<EnvLaneConfig>({
    cwd: invocationCwd,
    configFile: options.configFile,
    name: 'env-lane',
  })
  assertAbsolutePath(rootDir, 'Project root')
  return callNativeCore<ResolvedEnvLaneConfig>('core.resolveConfig', {
    cwd: invocationCwd,
    rootDir,
    configFile,
    rawConfig: config ?? {},
  })
}

export async function loadEnvLaneConfig(
  options: { cwd?: string; configFile?: string } = {},
): Promise<ResolvedEnvLaneConfig> {
  try {
    return await loadEnvLaneConfigUnchecked(options)
  } catch (error) {
    if (error instanceof EnvLaneError) throw error
    const cause = error instanceof Error ? error.message : String(error)
    throw new EnvLaneError('CONFIG_LOAD_FAILED', `Failed to load env-lane config: ${cause}`, {
      cause,
      configFile: options.configFile,
    })
  }
}
