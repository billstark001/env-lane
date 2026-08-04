import {
  type AbsolutePath,
  assertAbsolutePath,
  resolveFromDirectory,
  resolveInvocationCwd,
} from '../adapters/paths.js'
import { executeChildProcess } from '../adapters/process.js'
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
  const invocationCwd = resolveInvocationCwd(options.cwd)
  const resolved =
    options.resolved ?? (await resolveInjectedEnv({ ...options, cwd: invocationCwd }))
  const childCwd = resolveChildCwd(childCwdSelection(options.runCwd), invocationCwd, resolved)

  return executeChildProcess({
    command: options.command,
    cwd: childCwd,
    env: resolved.values,
  })
}
