import { type ChildProcess, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
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

function windowsBatchCommand(command: string, cwd: string, env: Record<string, string>): boolean {
  if (process.platform !== 'win32') return false
  const extension = path.extname(command).toLowerCase()
  if (extension && extension !== '.cmd' && extension !== '.bat') return false
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const pathExt =
    Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ??
    '.COM;.EXE;.BAT;.CMD'
  const directories =
    path.dirname(command) === '.' ? [cwd, ...pathValue.split(path.delimiter)] : [cwd]
  for (const directory of directories) {
    const base = path.resolve(cwd, directory, command)
    for (const suffix of extension ? [''] : pathExt.split(';')) {
      if (!extension && !suffix.startsWith('.')) continue
      try {
        if (!statSync(base + suffix).isFile()) continue
      } catch {
        continue
      }
      return ['.cmd', '.bat'].includes((extension || suffix).toLowerCase())
    }
  }
  return false
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
  const child = spawn(options.command[0], options.command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
    // Windows requires a shell for batch files, but direct executables must not
    // go through cmd.exe: that would turn ENOENT into an unrelated shell exit.
    shell: windowsBatchCommand(options.command[0], options.cwd, options.env),
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
