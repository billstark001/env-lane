import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { loadEnvLaneConfig } from '../adapters/config.js'
import { type AbsolutePath, resolveInvocationCwd } from '../adapters/paths.js'
import { EnvLaneError } from '../domain/errors.js'
import type { ResolvedEnvLaneConfig, ResolveEnvOptions, WorkspacePackage } from '../domain/types.js'

type WorkspaceResolveOptions = Pick<ResolveEnvOptions, 'cwd' | 'configFile'> & {
  config?: ResolvedEnvLaneConfig
  packages?: WorkspacePackage[]
}

type ResolvedWorkspaceOptions = Omit<WorkspaceResolveOptions, 'cwd'> & { cwd?: AbsolutePath }

function readPackageName(dir: string): string | undefined {
  const file = path.join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }
    return typeof json.name === 'string' ? json.name : undefined
  } catch {
    return undefined
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export async function listWorkspacePackages(
  options: WorkspaceResolveOptions = {},
): Promise<WorkspacePackage[]> {
  const config = options.config ?? (await loadEnvLaneConfig(options))
  return listWorkspacePackagesForConfig(config)
}

export async function listWorkspacePackagesForConfig(
  config: ResolvedEnvLaneConfig,
): Promise<WorkspacePackage[]> {
  const entries = await fg(config.workspace.packageGlobs, {
    cwd: config.rootDir,
    onlyDirectories: true,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**'],
  })
  const packages: WorkspacePackage[] = []

  if (config.workspace.includeRoot) {
    const rootName = readPackageName(config.rootDir)
    packages.push({
      name: rootName,
      dir: config.rootDir,
      relativeDir: '.',
      aliases: unique(['root', '.', rootName].filter(Boolean) as string[]),
      isRoot: true,
    })
  }

  for (const dir of entries.sort()) {
    if (dir === config.rootDir) continue
    const packageJson = path.join(dir, 'package.json')
    if (!existsSync(packageJson)) continue
    const name = readPackageName(dir)
    const relativeDir = path.relative(config.rootDir, dir).replaceAll(path.sep, '/')
    packages.push({
      name,
      dir,
      relativeDir,
      aliases: unique([name, path.basename(dir), relativeDir].filter(Boolean) as string[]),
      isRoot: false,
    })
  }

  for (const [alias, target] of Object.entries(config.workspace.aliases)) {
    const matched = packages.find(
      (pkg) =>
        pkg.name === target || pkg.relativeDir === target || path.basename(pkg.dir) === target,
    )
    if (matched && !matched.aliases.includes(alias)) matched.aliases.push(alias)
  }

  const byDir = new Map<string, WorkspacePackage>()
  for (const pkg of packages) byDir.set(pkg.dir, pkg)
  return [...byDir.values()]
}

function targetMatchesPackage(pkg: WorkspacePackage, value: string): boolean {
  return pkg.aliases.includes(value) || pkg.name === value || pkg.relativeDir === value
}

function formatAvailableTargets(packages: WorkspacePackage[]): string {
  return unique(packages.flatMap((pkg) => pkg.aliases)).join(', ')
}

function resolveTargetPackageFromListResolved(
  target: string | undefined,
  config: ResolvedEnvLaneConfig,
  packages: WorkspacePackage[],
  options: ResolvedWorkspaceOptions,
): WorkspacePackage {
  let value = (target || config.workspace.defaultTarget || '').trim()

  if (!value && options.cwd) {
    const matchedPkg = packages
      .filter((pkg) => options.cwd === pkg.dir || options.cwd?.startsWith(pkg.dir + path.sep))
      .sort((a, b) => b.dir.length - a.dir.length)[0]
    if (matchedPkg) {
      value = matchedPkg.aliases[0] || matchedPkg.name || matchedPkg.relativeDir
    }
  }

  if (!value) {
    const nonRoot = packages.filter((pkg) => !pkg.isRoot)
    if (nonRoot.length === 0) return packages.find((pkg) => pkg.isRoot) ?? packages[0]

    const rootPkg = packages.find((pkg) => pkg.isRoot)
    if (rootPkg && options.cwd) {
      if (options.cwd === rootPkg.dir) {
        return rootPkg
      }
    }

    throw new EnvLaneError(
      'MISSING_TARGET',
      `Missing target. Available targets: ${formatAvailableTargets(packages)}`,
    )
  }

  const matches = packages.filter((pkg) => targetMatchesPackage(pkg, value))
  if (matches.length > 1) {
    throw new EnvLaneError(
      'AMBIGUOUS_TARGET',
      `Ambiguous target '${value}'. Matches: ${matches
        .map((pkg) => pkg.name ?? pkg.relativeDir)
        .join(', ')}. Use a package name, relative directory, or configure a unique alias.`,
    )
  }
  const matched = matches[0]
  if (!matched) {
    throw new EnvLaneError(
      'UNKNOWN_TARGET',
      `Unknown target '${value}'. Available targets: ${formatAvailableTargets(packages)}`,
    )
  }
  return matched
}

export function resolveTargetPackageFromList(
  target: string | undefined,
  config: ResolvedEnvLaneConfig,
  packages: WorkspacePackage[],
  options: WorkspaceResolveOptions = {},
): WorkspacePackage {
  return resolveTargetPackageFromListResolved(target, config, packages, {
    ...options,
    cwd: options.cwd ? resolveInvocationCwd(options.cwd) : undefined,
  })
}

export async function resolveTargetPackage(
  target: string | undefined,
  options: WorkspaceResolveOptions = {},
): Promise<WorkspacePackage> {
  const resolvedOptions = { ...options, cwd: resolveInvocationCwd(options.cwd) }
  const config = options.config ?? (await loadEnvLaneConfig(resolvedOptions))
  const packages = options.packages ?? (await listWorkspacePackagesForConfig(config))
  return resolveTargetPackageFromListResolved(target, config, packages, resolvedOptions)
}
