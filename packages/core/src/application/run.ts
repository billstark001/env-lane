import {
  type AbsolutePath,
  assertAbsolutePath,
  resolveFromDirectory,
  resolveInvocationCwd,
} from '../adapters/paths.js'
import {
  type ChildRunResult,
  childRunStatus,
  executeChildProcess,
  type StartedChildProcess,
} from '../adapters/process.js'
import { EnvLaneError } from '../domain/errors.js'
import type { ResolvedEnv } from '../domain/types.js'
import { resolveInjectedEnv } from './dotenv.js'

type ChildCwdSelection = { kind: 'target' } | { kind: 'root' } | { kind: 'path'; path: string }

function childCwdSelection(value: 'target' | 'root' | string | undefined): ChildCwdSelection {
  if (!value || value === 'target') return { kind: 'target' }
  if (value === 'root') return { kind: 'root' }
  return { kind: 'path', path: value }
}

function resolveChildCwd(
  selection: ChildCwdSelection,
  invocationCwd: AbsolutePath,
  resolved: ResolvedEnv,
): AbsolutePath {
  if (selection.kind === 'target') {
    assertAbsolutePath(resolved.target.dir, 'Resolved target directory')
    return resolved.target.dir
  }
  if (selection.kind === 'root') {
    assertAbsolutePath(resolved.rootDir, 'Resolved project root')
    return resolved.rootDir
  }
  return resolveFromDirectory(invocationCwd, selection.path)
}

/** Run a child with resolved dotenv values, using the target directory by default. */
export interface RunWithInjectedEnvOptions {
  cwd?: string
  configFile?: string
  target?: string
  build?: string
  command: string[]
  runCwd?: 'target' | 'root' | string
  resolved?: ResolvedEnv
}

export type { ChildRunResult, RunSpawnError, StartedChildProcess } from '../adapters/process.js'

/** Start a child and expose its streams and structured completion status. */
export async function spawnWithInjectedEnv(
  options: RunWithInjectedEnvOptions & { stdio?: 'inherit' | 'pipe' },
): Promise<StartedChildProcess> {
  if (!options.command.length) throw new EnvLaneError('MISSING_COMMAND', 'Missing command.')
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const resolved =
    options.resolved ?? (await resolveInjectedEnv({ ...options, cwd: invocationCwd }))
  const childCwd = resolveChildCwd(childCwdSelection(options.runCwd), invocationCwd, resolved)

  return executeChildProcess({
    command: options.command,
    cwd: childCwd,
    env: resolved.values,
    stdio: options.stdio,
  })
}

/** Await a child while retaining its normal exit, signal, or spawn failure. */
export async function runWithInjectedEnvDetailed(
  options: RunWithInjectedEnvOptions,
): Promise<ChildRunResult> {
  return (await spawnWithInjectedEnv(options)).completed
}

/** Published numeric API: normal exits pass through; POSIX signals use 128 + signal. */
export async function runWithInjectedEnv(options: RunWithInjectedEnvOptions): Promise<number> {
  return childRunStatus(await runWithInjectedEnvDetailed(options))
}
