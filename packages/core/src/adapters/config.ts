import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig as c12LoadConfig } from 'c12'
import { findUp } from 'find-up'
import YAML from 'yaml'
import { EnvLaneError } from '../domain/errors.js'
import type { EnvLaneConfig, ResolvedEnvLaneConfig } from '../domain/types.js'
import { callNativeCore } from './native.js'
import {
  type AbsolutePath,
  absoluteDirname,
  assertAbsolutePath,
  resolveFromDirectory,
  resolveInvocationCwd,
} from './paths.js'

export function defineConfig(config: EnvLaneConfig): EnvLaneConfig {
  return config
}

export async function findWorkspaceRoot(cwd?: string): Promise<AbsolutePath> {
  const invocationCwd = resolveInvocationCwd(cwd)
  const marker = await findUp(['pnpm-workspace.yaml', 'package.json', '.git'], {
    cwd: invocationCwd,
    type: 'file',
  })
  const [gitDirectory, gitFile] = await Promise.all([
    findUp('.git', { cwd: invocationCwd, type: 'directory' }),
    findUp('.git', { cwd: invocationCwd, type: 'file' }),
  ])
  const gitMarker = [gitDirectory, gitFile]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)[0]
  let gitRoot: AbsolutePath | undefined
  if (gitMarker) {
    assertAbsolutePath(gitMarker, 'Git marker')
    gitRoot = absoluteDirname(gitMarker)
  }
  if (gitRoot) {
    const relative = marker ? path.relative(path.dirname(marker), gitRoot) : undefined
    if (
      !marker ||
      (relative !== undefined &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    ) {
      return gitRoot
    }
  }
  if (!marker) return invocationCwd
  assertAbsolutePath(marker, 'Workspace marker')
  if (path.basename(marker) === '.git') return absoluteDirname(marker)
  if (path.basename(marker) === 'package.json') {
    const markerDir = absoluteDirname(marker)
    const pnpm = await findUp('pnpm-workspace.yaml', { cwd: markerDir, type: 'file' })
    if (!pnpm) return markerDir
    assertAbsolutePath(pnpm, 'pnpm workspace file')
    const pnpmDir = absoluteDirname(pnpm)
    if (gitRoot) {
      const relative = path.relative(gitRoot, pnpmDir)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return markerDir
      }
    }
    return pnpmDir
  }
  return absoluteDirname(marker)
}

export function readPnpmWorkspaceGlobs(rootDir: string): string[] {
  const workspaceFile = path.join(rootDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspaceFile)) return []
  const doc = YAML.parse(readFileSync(workspaceFile, 'utf8')) as { packages?: unknown } | null
  return Array.isArray(doc?.packages)
    ? doc.packages.filter((item): item is string => typeof item === 'string')
    : []
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
