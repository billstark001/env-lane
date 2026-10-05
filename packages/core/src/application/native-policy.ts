import { loadEnvLaneConfig } from '../adapters/config.js'
import { callNativeCore } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
import type { EnvCheckResult, EnvSyncResult } from './policy.js'

/** Run a named check using the resolved configuration and the current shell environment. */
export async function runEnvCheck(
  name: string,
  options: { cwd?: string; configFile?: string; build?: string } = {},
): Promise<EnvCheckResult> {
  const config = await loadEnvLaneConfig(options)
  return callNativeCore<EnvCheckResult>('core.runEnvCheck', {
    name,
    cwd: resolveInvocationCwd(options.cwd),
    configFile: options.configFile,
    config,
    build: options.build,
    processEnv: process.env,
  })
}

/** Apply or preview a named environment sync. A dry run does not write the target file. */
export async function runEnvSync(
  name: string,
  options: { cwd?: string; configFile?: string; build?: string; dryRun?: boolean } = {},
): Promise<EnvSyncResult> {
  const config = await loadEnvLaneConfig(options)
  return callNativeCore<EnvSyncResult>('core.runEnvSync', {
    name,
    cwd: resolveInvocationCwd(options.cwd),
    configFile: options.configFile,
    config,
    build: options.build,
    dryRun: options.dryRun,
    processEnv: process.env,
  })
}
