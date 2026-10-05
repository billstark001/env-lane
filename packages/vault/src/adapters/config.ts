import { existsSync } from 'node:fs'
import path from 'node:path'
import { EnvLaneError, loadEnvLaneConfig } from '@env-lane/core'
import { loadConfig as c12LoadConfig } from 'c12'
import type { VaultRestoreRedaction, VaultRestoreReveal } from '../domain/types.js'
import { bindVaultHostConfig, callNativeVault } from './native.js'
import { resolveInvocationCwd } from './paths.js'

export interface VaultConfig {
  baseDir: string
  envFiles: string[]
  outputDir: string
  outputFile: string
  storePath: string
  trackDeletions: boolean
  autoRemapPaths: boolean
  allowUnmanaged: boolean
  restore: {
    redaction: VaultRestoreRedaction
    reveal: VaultRestoreReveal | false
    promptLoop: boolean
  }
  exclude: Array<{ files: string[]; keys: string[] }>
  sort?: Record<string, { file: string; template: string; files?: Record<string, string> }>
  disableUnsafeWarning: boolean
}

export function defineVaultConfig<T extends Record<string, unknown>>(config: T): T {
  return config
}

export async function loadVaultConfig(
  configPath?: string,
  options?: {
    cwd?: string
    vaultConfigFile?: string
    autoRemapPaths?: boolean
    allowUnmanaged?: boolean
    restoreRedaction?: VaultRestoreRedaction
    restoreReveal?: VaultRestoreReveal | false
    promptLoop?: boolean
  },
): Promise<VaultConfig> {
  if (configPath && options?.vaultConfigFile) {
    throw new EnvLaneError('VAULT_INVALID_CONFIG', 'Specify one Vault config path.')
  }
  const cwd = resolveInvocationCwd(
    options?.cwd ??
      (configPath && path.isAbsolute(configPath) ? path.dirname(configPath) : undefined),
  )
  const hostConfig = await loadEnvLaneConfig({ cwd })
  if (!hostConfig.vault?.enabled) {
    throw new EnvLaneError('PLUGIN_DISABLED', 'Vault plugin is not enabled in the main config.')
  }
  const requested = configPath ?? options?.vaultConfigFile
  const file = requested
    ? path.resolve(cwd, requested)
    : path.resolve(hostConfig.rootDir, hostConfig.vault.configFile)
  const nativeExtensions = ['json', 'yaml', 'yml', 'jsonc', 'json5', 'toml']
  const nativeFile = (
    path.extname(file)
      ? [file]
      : [file, ...nativeExtensions.map((extension) => `${file}.${extension}`)]
  ).find(
    (candidate) =>
      existsSync(candidate) && nativeExtensions.includes(path.extname(candidate).slice(1)),
  )
  let resolved: VaultConfig
  if (nativeFile) {
    resolved = callNativeVault<VaultConfig>('vault.loadConfig', {
      configFile: nativeFile,
      disableUnsafeWarning: hostConfig.vault.disableUnsafeWarning,
      hostConfig,
      projectRoot: hostConfig.rootDir,
    })
  } else {
    const loaded = await c12LoadConfig<Record<string, unknown>>({
      name: 'env-lane.vault',
      cwd: hostConfig.rootDir,
      configFile: path.relative(hostConfig.rootDir, file),
      packageJson: false,
      dotenv: false,
      rcFile: false,
      globalRc: false,
      configFileRequired: true,
    })
    if (!loaded.configFile) {
      throw new EnvLaneError('VAULT_CONFIG_NOT_FOUND', `Vault config does not exist: ${file}`)
    }
    resolved = callNativeVault<VaultConfig>('vault.resolveConfig', {
      rawConfig: loaded.config ?? {},
      baseDir: path.dirname(path.resolve(loaded.configFile)),
      disableUnsafeWarning: hostConfig.vault.disableUnsafeWarning,
      hostConfig,
      projectRoot: hostConfig.rootDir,
    })
  }
  if (options?.autoRemapPaths !== undefined) resolved.autoRemapPaths = options.autoRemapPaths
  if (options?.allowUnmanaged !== undefined) resolved.allowUnmanaged = options.allowUnmanaged
  if (options?.restoreRedaction !== undefined) resolved.restore.redaction = options.restoreRedaction
  if (options?.restoreReveal !== undefined) resolved.restore.reveal = options.restoreReveal
  if (options?.promptLoop !== undefined) resolved.restore.promptLoop = options.promptLoop
  bindVaultHostConfig(resolved, hostConfig)
  callNativeVault('vault.validateConfig', { config: resolved })
  return resolved
}
