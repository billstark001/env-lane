import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { loadEnvLaneConfig } from './config.js';
import type { ResolveEnvOptions, WorkspacePackage } from './types.js';

function readPackageName(dir: string): string | undefined {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown };
    return typeof json.name === 'string' ? json.name : undefined;
  } catch {
    return undefined;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export async function listWorkspacePackages(options: Pick<ResolveEnvOptions, 'cwd' | 'configFile'> = {}): Promise<WorkspacePackage[]> {
  const config = await loadEnvLaneConfig(options);
  const entries = await fg(config.workspace.packageGlobs, {
    cwd: config.rootDir,
    onlyDirectories: true,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**']
  });
  const packages: WorkspacePackage[] = [];

  if (config.workspace.includeRoot) {
    const rootName = readPackageName(config.rootDir);
    packages.push({
      name: rootName,
      dir: config.rootDir,
      relativeDir: '.',
      aliases: unique(['root', '.', rootName].filter(Boolean) as string[]),
      isRoot: true
    });
  }

  for (const dir of entries.sort()) {
    const packageJson = path.join(dir, 'package.json');
    if (!existsSync(packageJson)) continue;
    const name = readPackageName(dir);
    const relativeDir = path.relative(config.rootDir, dir).replaceAll(path.sep, '/');
    packages.push({
      name,
      dir,
      relativeDir,
      aliases: unique([name, path.basename(dir), relativeDir].filter(Boolean) as string[]),
      isRoot: false
    });
  }

  for (const [alias, target] of Object.entries(config.workspace.aliases)) {
    const matched = packages.find(pkg => pkg.name === target || pkg.relativeDir === target || path.basename(pkg.dir) === target);
    if (matched && !matched.aliases.includes(alias)) matched.aliases.push(alias);
  }

  const byDir = new Map<string, WorkspacePackage>();
  for (const pkg of packages) byDir.set(pkg.dir, pkg);
  return [...byDir.values()];
}

export async function resolveTargetPackage(target: string | undefined, options: Pick<ResolveEnvOptions, 'cwd' | 'configFile'> = {}): Promise<WorkspacePackage> {
  const [config, packages] = await Promise.all([loadEnvLaneConfig(options), listWorkspacePackages(options)]);
  const value = (target || config.workspace.defaultTarget || '').trim();

  if (!value) {
    const nonRoot = packages.filter(pkg => !pkg.isRoot);
    if (nonRoot.length === 0) return packages.find(pkg => pkg.isRoot) ?? packages[0];
    throw new Error(`Missing target. Available targets: ${packages.flatMap(pkg => pkg.aliases).join(', ')}`);
  }

  const matched = packages.find(pkg => pkg.aliases.includes(value) || pkg.name === value || pkg.relativeDir === value);
  if (!matched) {
    throw new Error(`Unknown target '${value}'. Available targets: ${packages.flatMap(pkg => pkg.aliases).join(', ')}`);
  }
  return matched;
}
