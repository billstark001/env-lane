import { execa } from 'execa'
import { resolveInjectedEnv } from './dotenv.js'
import { getLogger } from './logger.js'

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
  const resolved = await resolveInjectedEnv(options)
  const cwd =
    options.runCwd === 'root'
      ? resolved.rootDir
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
    const logger = getLogger()
    logger.info(
      `[env-lane] target=${resolved.target.name ?? resolved.target.relativeDir} build=${resolved.build}`,
    )
    logger.info(`[env-lane] loaded=${loaded}`)
    if (missing) logger.info(`[env-lane] missing=${missing}`)
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
