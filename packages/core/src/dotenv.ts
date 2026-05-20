import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { loadEnvLaneConfig } from './config.js'
import type { EnvFileRef, EnvSource, ResolvedEnv, ResolveEnvOptions } from './types.js'
import { resolveTargetPackage } from './workspace.js'

export function resolveBuildName(
  options: ResolveEnvOptions,
  envKey: string,
  defaultBuild: string,
): string {
  const raw = String(options.build ?? process.env[envKey] ?? defaultBuild).trim()
  if (!raw) throw new Error('Build name is empty.')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw)) throw new Error(`Invalid build name '${raw}'.`)
  return raw
}

function patternToFile(
  pattern: string,
  build: string,
  localBuildName: string,
  localOverrideFile: string,
): string {
  if (pattern === '.env.{build}' && build === localBuildName) return localOverrideFile
  return pattern.replaceAll('{build}', build)
}

export async function listEnvFiles(options: ResolveEnvOptions = {}): Promise<EnvFileRef[]> {
  const config = await loadEnvLaneConfig(options)
  const target = await resolveTargetPackage(options.target, options)
  const build = resolveBuildName(options, config.selector.envKey, config.selector.defaultBuild)
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

function lineForKey(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
  const idx = lines.findIndex((line) => re.test(line))
  return idx >= 0 ? idx + 1 : undefined
}

export async function resolveInjectedEnv(options: ResolveEnvOptions = {}): Promise<ResolvedEnv> {
  const config = await loadEnvLaneConfig(options)
  const target = await resolveTargetPackage(options.target, options)
  const build = resolveBuildName(options, config.selector.envKey, config.selector.defaultBuild)
  const files = await listEnvFiles(options)
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
    const parsed = parse(content)
    if (
      config.selector.forbidInDotenv &&
      Object.prototype.hasOwnProperty.call(parsed, config.selector.envKey)
    ) {
      throw new Error(
        `${config.selector.envKey} is a selector and must not be stored in dotenv files (${file.relativePath}).`,
      )
    }
    for (const [key, value] of Object.entries(parsed)) {
      values[key] = value
      sources[key] = {
        source: 'dotenv',
        file: file.path,
        relativeFile: file.relativePath,
        line: lineForKey(content, key),
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
