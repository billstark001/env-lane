import { execa } from 'execa'
import { resolveInjectedEnv } from './dotenv.js'
import { EnvLaneError } from './errors.js'
import type { ResolvedEnv } from './types.js'

export async function runWithInjectedEnv(options: {
  cwd?: string
  configFile?: string
  target?: string
  build?: string
  command: string[]
  runCwd?: 'target' | 'root' | string
  resolved?: ResolvedEnv
}): Promise<number> {
  if (!options.command.length) throw new EnvLaneError('MISSING_COMMAND', 'Missing command.')
  const resolved = options.resolved ?? (await resolveInjectedEnv(options))
  const cwd =
    options.runCwd === 'root'
      ? resolved.rootDir
      : !options.runCwd || options.runCwd === 'target'
        ? resolved.target.dir
        : options.runCwd

  const subprocess = execa(options.command[0], options.command.slice(1), {
    cwd,
    env: resolved.values,
    stdio: 'inherit',
    reject: false,
    shell: process.platform === 'win32',
  })
  const result = await subprocess
  return result.exitCode ?? 1
}
