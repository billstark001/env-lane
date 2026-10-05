import type { ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { constants } from 'node:os'
import spawn from 'cross-spawn'
import type { AbsolutePath } from './paths.js'

export interface RunSpawnError {
  code: string
  message: string
  exitStatus: 126 | 127
}

export interface ChildRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  spawnError?: RunSpawnError
}

export interface StartedChildProcess {
  child: ChildProcess
  completed: Promise<ChildRunResult>
}

function directoryExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function spawnError(error: Error & { code?: string }, cwd: string): RunSpawnError {
  return {
    code: error.code ?? 'RUN_SPAWN_FAILED',
    message: error.message,
    exitStatus: error.code === 'ENOENT' && directoryExists(cwd) ? 127 : 126,
  }
}

export function childRunStatus(result: ChildRunResult): number {
  if (result.spawnError) return result.spawnError.exitStatus
  if (result.exitCode !== null) return result.exitCode
  const number = result.signal ? constants.signals[result.signal] : undefined
  return number === undefined ? 1 : 128 + number
}

/** Stdio is inherited by default. With `pipe`, the caller must consume the streams. */
export function executeChildProcess(options: {
  command: string[]
  cwd: AbsolutePath
  env: Record<string, string>
  stdio?: 'inherit' | 'pipe'
}): StartedChildProcess {
  // cross-spawn escapes cmd.exe metacharacters, but cmd.exe still treats line
  // breaks as command separators for batch-file shims.
  if (process.platform === 'win32' && options.command.some((part) => /[\r\n]/.test(part))) {
    throw new TypeError('Windows command arguments cannot contain line breaks.')
  }
  const child = spawn(options.command[0], options.command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
  })
  let failure: RunSpawnError | undefined
  const completed = new Promise<ChildRunResult>((resolve) => {
    child.once('error', (error) => {
      failure = spawnError(error, options.cwd)
    })
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode: failure ? null : exitCode,
        signal,
        ...(failure ? { spawnError: failure } : {}),
      })
    })
  })
  return { child, completed }
}
