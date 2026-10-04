import { loadEnvLaneConfig } from '../adapters/config.js'
import { emitDiagnostic } from '../adapters/logger.js'
import { callNativeCore } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
import { EnvLaneError } from '../domain/errors.js'
import type {
  EnvFileRef,
  ResolvedEnv,
  ResolvedEnvLaneConfig,
  ResolveEnvOptions,
  WorkspacePackage,
} from '../domain/types.js'

export function resolveBuildName(
  options: ResolveEnvOptions,
  envKey: string,
  defaultBuild: string,
  validation: {
    builds?: string[]
    mode?: 'off' | 'warn' | 'error'
  } = {},
): string {
  const raw = String(options.build ?? process.env[envKey] ?? defaultBuild).trim()
  if (!raw) throw new EnvLaneError('INVALID_BUILD', 'Build name is empty.')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(raw)) {
    throw new EnvLaneError('INVALID_BUILD', `Invalid build name '${raw}'.`)
  }
  const builds = validation.builds ?? []
  const mode = validation.mode ?? 'warn'
  if (builds.length > 0 && !builds.includes(raw) && mode !== 'off') {
    const message = `Build '${raw}' is not listed in selector.builds: ${builds.join(', ')}.`
    if (mode === 'error') throw new EnvLaneError('UNLISTED_BUILD', message)
    emitDiagnostic({
      code: 'UNLISTED_BUILD',
      level: 'warning',
      scope: 'core',
      message,
      details: { build: raw, allowedBuilds: builds },
    })
  }
  return raw
}

function nativeResolveRequest(options: ResolveEnvOptions, config: ResolvedEnvLaneConfig) {
  return {
    cwd: resolveInvocationCwd(options.cwd),
    configFile: options.configFile,
    config,
    target: options.target,
    build: options.build,
    includeProcessEnv: options.includeProcessEnv,
    requireOverride: options.requireOverride,
    processEnv: process.env,
  }
}

/** List the selected target's dotenv inputs in precedence order without writing files. */
export async function listEnvFiles(options: ResolveEnvOptions = {}): Promise<EnvFileRef[]> {
  const config = options.config ?? (await loadEnvLaneConfig(options))
  return callNativeCore<EnvFileRef[]>('core.listEnvFiles', nativeResolveRequest(options, config))
}

export function listEnvFilesForTarget(
  config: ResolvedEnvLaneConfig,
  target: WorkspacePackage,
  options: ResolveEnvOptions = {},
  resolvedBuild?: string,
): EnvFileRef[] {
  // biome-ignore lint/security/noSecrets: This is a native operation identifier.
  return callNativeCore<EnvFileRef[]>('core.listEnvFilesForTarget', {
    cwd: resolveInvocationCwd(options.cwd),
    config,
    targetPackage: target,
    build: options.build,
    resolvedBuild,
    requireOverride: options.requireOverride,
    processEnv: process.env,
  })
}

/** Resolve the final environment and its value origins through native Core. */
export async function resolveInjectedEnv(options: ResolveEnvOptions = {}): Promise<ResolvedEnv> {
  const config = options.config ?? (await loadEnvLaneConfig(options))
  return callNativeCore<ResolvedEnv>(
    'core.resolveInjectedEnv',
    nativeResolveRequest(options, config),
  )
}
