import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadEnvLaneConfig } from './config.js'
import { parseEnvDocument } from './env-document.js'
import { getLogger } from './logger.js'
import type {
  EnvFileRef,
  EnvSource,
  ResolvedEnv,
  ResolvedEnvLaneConfig,
  ResolveEnvOptions,
  WorkspacePackage,
} from './types.js'
import { resolveTargetPackage } from './workspace.js'

export function resolveBuildName(
  options: ResolveEnvOptions,
  envKey: string,
  defaultBuild: string,
  validation: { builds?: string[]; mode?: 'off' | 'warn' | 'error' } = {},
): string {
  const raw = String(options.build ?? process.env[envKey] ?? defaultBuild).trim()
  if (!raw) throw new Error('Build name is empty.')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw)) throw new Error(`Invalid build name '${raw}'.`)
  const builds = validation.builds ?? []
  const mode = validation.mode ?? 'warn'
  if (builds.length > 0 && !builds.includes(raw) && mode !== 'off') {
    const message = `Build '${raw}' is not listed in selector.builds: ${builds.join(', ')}.`
    if (mode === 'error') throw new Error(message)
    getLogger().warn(message)
  }
  return raw
}

function patternToFile(
  pattern: string,
  build: string,
  localBuildName: string,
  localOverrideFile: string,
): string {
  if (pattern.includes('{build}') && build === localBuildName) return localOverrideFile
  return pattern.replaceAll('{build}', build)
}

export async function listEnvFiles(options: ResolveEnvOptions = {}): Promise<EnvFileRef[]> {
  const config = await loadEnvLaneConfig(options)
  const target = await resolveTargetPackage(options.target, { ...options, config })
  return listEnvFilesForTarget(config, target, options)
}

export function listEnvFilesForTarget(
  config: ResolvedEnvLaneConfig,
  target: WorkspacePackage,
  options: ResolveEnvOptions = {},
): EnvFileRef[] {
  const build = resolveBuildName(options, config.selector.envKey, config.selector.defaultBuild, {
    builds: config.selector.builds,
    mode: config.selector.buildValidation,
  })
  return config.dotenv.order.map((pattern, index) => {
    const fileName = patternToFile(
      pattern,
      build,
      config.dotenv.localBuildName,
      config.dotenv.localOverrideFile,
    )
    const filePath = path.resolve(target.dir, fileName)
    return {
      kind: index === 0 ? 'base' : index === 1 ? 'override' : 'custom',
      path: filePath,
      relativePath: path.relative(config.rootDir, filePath).replaceAll(path.sep, '/'),
      exists: existsSync(filePath),
      required: index > 0 && Boolean(options.requireOverride ?? config.dotenv.requireOverride),
      order: index,
    } satisfies EnvFileRef
  })
}

export async function resolveInjectedEnv(options: ResolveEnvOptions = {}): Promise<ResolvedEnv> {
  const config = await loadEnvLaneConfig(options)
  const target = await resolveTargetPackage(options.target, { ...options, config })
  const build = resolveBuildName(options, config.selector.envKey, config.selector.defaultBuild, {
    builds: config.selector.builds,
    mode: config.selector.buildValidation,
  })
  const files = listEnvFilesForTarget(config, target, options)
  const values: Record<string, string> = {}
  const sources: Record<string, EnvSource> = {}

  const missingRequired = files.filter((file) => file.required && !file.exists)
  if (missingRequired.length)
    throw new Error(
      `Missing required env file(s): ${missingRequired.map((file) => file.relativePath).join(', ')}`,
    )

  for (const file of files) {
    if (!file.exists) continue
    const content = readFileSync(file.path, 'utf8')
    const envDocument = parseEnvDocument(content)
    if (config.selector.forbidInDotenv && envDocument.currentMap.has(config.selector.envKey)) {
      throw new Error(
        `${config.selector.envKey} is a selector and must not be stored in dotenv files (${file.relativePath}).`,
      )
    }
    for (const [key, entry] of envDocument.currentMap) {
      values[key] = entry.effectiveValue
      sources[key] = {
        source: 'dotenv',
        file: file.path,
        relativeFile: file.relativePath,
        line: entry.lineNumber,
      }
    }
  }

  if (options.includeProcessEnv ?? config.dotenv.includeProcessEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        sources[key] = { source: 'process', shellOverride: true }
      } else {
        sources[key] = { source: 'process' }
      }
      values[key] = value
    }
  }

  values[config.selector.envKey] = build
  sources[config.selector.envKey] = {
    source: 'selector',
    shellOverride: Object.prototype.hasOwnProperty.call(process.env, config.selector.envKey),
  }

  return {
    rootDir: config.rootDir,
    target,
    build,
    selectorKey: config.selector.envKey,
    files,
    values,
    sources,
  }
}
