import { loadEnvLaneConfig } from '../adapters/config.js'
import { callNativeCore } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
import type {
  EnvFileRef,
  ResolvedEnv,
  ResolvedEnvLaneConfig,
  ResolveEnvOptions,
  WorkspacePackage,
} from '../domain/types.js'

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
