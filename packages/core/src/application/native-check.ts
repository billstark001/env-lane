import { loadEnvLaneConfig } from '../adapters/config.js'
import { callNativeCore } from '../adapters/native.js'
import { resolveInvocationCwd } from '../adapters/paths.js'
/** Result of scanning dotenv files for the selector key and required overrides. */
export interface CheckResult {
  ok: boolean
  selectorKey: string
  violations: Array<{ file: string; relativeFile: string; line?: number }>
  missingRequired: Array<{ file: string; relativeFile: string; target: string }>
}

export async function checkDotenvSelector(
  options: {
    cwd?: string
    configFile?: string
    target?: string
    build?: string
    requireOverride?: boolean
  } = {},
): Promise<CheckResult> {
  const config = await loadEnvLaneConfig(options)
  return callNativeCore<CheckResult>('core.checkDotenvSelector', {
    cwd: resolveInvocationCwd(options.cwd),
    configFile: options.configFile,
    config,
    target: options.target,
    build: options.build,
    requireOverride: options.requireOverride,
    processEnv: process.env,
  })
}
