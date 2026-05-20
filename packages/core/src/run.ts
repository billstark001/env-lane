import { execa } from 'execa'
import { loadEnvLaneConfig } from './config.js'
import { resolveInjectedEnv } from './dotenv.js'

export async function runWithInjectedEnv(options: {
  cwd?: string
  configFile?: string
  target?: string
  build?: string
  command: string[]
  runCwd?: 'target' | 'root' | string
  quiet?: boolean
}): Promise<number> {
  if (!options.command.length) throw new Error('Missing command.')
  const config = await loadEnvLaneConfig(options)
  const resolved = await resolveInjectedEnv(options)
  const cwd =
    options.runCwd === 'root'
      ? config.rootDir
      : !options.runCwd || options.runCwd === 'target'
        ? resolved.target.dir
        : options.runCwd

  if (!options.quiet) {
    const loaded =
      resolved.files
        .filter((file) => file.exists)
        .map((file) => file.relativePath)
        .join(', ') || '<none>'
    const missing = resolved.files
      .filter((file) => !file.exists)
      .map((file) => file.relativePath)
      .join(', ')
    console.error(
      `[env-lane] target=${resolved.target.name ?? resolved.target.relativeDir} build=${resolved.build}`,
    )
    console.error(`[env-lane] loaded=${loaded}`)
    if (missing) console.error(`[env-lane] missing=${missing}`)
  }

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
