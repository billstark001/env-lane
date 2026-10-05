import { loadEnvLaneConfig } from '../adapters/config.js'
import { callNativeCore } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
import type { ResolvedEnvLaneConfig, ResolveEnvOptions, WorkspacePackage } from '../domain/types.js'

type WorkspaceResolveOptions = Pick<ResolveEnvOptions, 'cwd' | 'configFile'> & {
  config?: ResolvedEnvLaneConfig
  packages?: WorkspacePackage[]
}

/** Discover package directories using the compiled workspace patterns. */
export async function listWorkspacePackages(
  options: WorkspaceResolveOptions = {},
): Promise<WorkspacePackage[]> {
  const config = options.config ?? (await loadEnvLaneConfig(options))
  return listWorkspacePackagesForConfig(config)
}

/** Discover packages from a previously resolved config without loading it again. */
export async function listWorkspacePackagesForConfig(
  config: ResolvedEnvLaneConfig,
): Promise<WorkspacePackage[]> {
  return callNativeCore<WorkspacePackage[]>('core.listWorkspacePackages', {
    cwd: config.rootDir,
    config,
  })
}

/** Resolve a target using the native workspace snapshot and invocation directory. */
export async function resolveTargetPackage(
  target: string | undefined,
  options: WorkspaceResolveOptions = {},
): Promise<WorkspacePackage> {
  const cwd = resolveInvocationCwd(options.cwd)
  const config = options.config ?? (await loadEnvLaneConfig({ ...options, cwd }))
  return callNativeCore<WorkspacePackage>('core.resolveTargetPackage', {
    cwd,
    config,
    target,
    packages: options.packages,
  })
}

/** Resolve from a supplied package list; omitted cwd disables location inference. */
export function resolveTargetPackageFromList(
  target: string | undefined,
  config: ResolvedEnvLaneConfig,
  packages: WorkspacePackage[],
  options: WorkspaceResolveOptions = {},
): WorkspacePackage {
  return callNativeCore<WorkspacePackage>('core.resolveTargetPackage', {
    cwd: options.cwd ? resolveInvocationCwd(options.cwd) : config.rootDir,
    config,
    target,
    packages,
    inferFromCwd: Boolean(options.cwd),
  })
}
