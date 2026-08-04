import { execa } from 'execa'
import type { AbsolutePath } from './paths.js'

export async function executeChildProcess(options: {
  command: string[]
  cwd: AbsolutePath
  env: Record<string, string>
}): Promise<number> {
  const subprocess = execa(options.command[0], options.command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    reject: false,
    shell: process.platform === 'win32',
  })
  const result = await subprocess
  return result.exitCode ?? 1
}
