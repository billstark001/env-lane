import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig as c12LoadConfig } from 'c12'
import { findUp } from 'find-up'
import YAML from 'yaml'
import { z } from 'zod'
import type { EnvLaneConfig, ResolvedEnvLaneConfig } from './types.js'

const sortTargetSchema = z.object({
  file: z.string().min(1),
  template: z.string().min(1),
  files: z.record(z.string(), z.string().min(1)).optional(),
})

const schema = z
  .object({
    selector: z
      .object({
        envKey: z.string().min(1).optional(),
        defaultBuild: z.string().min(1).optional(),
        forbidInDotenv: z.boolean().optional(),
      })
      .optional(),
    workspace: z
      .object({
        packageGlobs: z.array(z.string().min(1)).optional(),
        aliases: z.record(z.string(), z.string().min(1)).optional(),
        defaultTarget: z.string().min(1).optional(),
        includeRoot: z.boolean().optional(),
      })
      .optional(),
    dotenv: z
      .object({
        order: z.array(z.string().min(1)).optional(),
        localBuildName: z.string().min(1).optional(),
        localOverrideFile: z.string().min(1).optional(),
        requireOverride: z.boolean().optional(),
        includeProcessEnv: z.boolean().optional(),
      })
      .optional(),
    vault: z
      .object({
        enabled: z.boolean().optional(),
        disableUnsafeWarning: z.boolean().optional(),
        configFile: z.string().min(1).optional(),
      })
      .optional(),
    sort: z.record(z.string(), sortTargetSchema).optional(),
  })
  .passthrough()

export function defineConfig(config: EnvLaneConfig): EnvLaneConfig {
  return config
}

export async function findWorkspaceRoot(cwd = process.cwd()): Promise<string> {
  const marker = await findUp(['pnpm-workspace.yaml', 'package.json', '.git'], {
    cwd,
    type: 'file',
  })
  if (!marker) return path.resolve(cwd)
  if (path.basename(marker) === '.git') return path.dirname(marker)
  if (path.basename(marker) === 'package.json') {
    const pnpm = await findUp('pnpm-workspace.yaml', { cwd: path.dirname(marker), type: 'file' })
    return pnpm ? path.dirname(pnpm) : path.dirname(marker)
  }
  return path.dirname(marker)
}

export function readPnpmWorkspaceGlobs(rootDir: string): string[] {
  const workspaceFile = path.join(rootDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspaceFile)) return []
  const doc = YAML.parse(readFileSync(workspaceFile, 'utf8')) as { packages?: unknown } | null
  return Array.isArray(doc?.packages)
    ? doc.packages.filter((item): item is string => typeof item === 'string')
    : []
}

export async function loadEnvLaneConfig(
  options: { cwd?: string; configFile?: string } = {},
): Promise<ResolvedEnvLaneConfig> {
  const rootDir = await findWorkspaceRoot(options.cwd)
  const loaded = await c12LoadConfig<EnvLaneConfig>({
    name: 'env-lane',
    cwd: rootDir,
    configFile: options.configFile,
    packageJson: false,
    dotenv: false,
    rcFile: false,
    globalRc: false,
  })
  const parsed = schema.parse(loaded.config ?? {})
  const workspaceGlobs = parsed.workspace?.packageGlobs ?? readPnpmWorkspaceGlobs(rootDir) ?? []
  return {
    rootDir,
    selector: {
      envKey: parsed.selector?.envKey ?? 'ENV_BUILD',
      defaultBuild: parsed.selector?.defaultBuild ?? 'local',
      forbidInDotenv: parsed.selector?.forbidInDotenv ?? true,
    },
    workspace: {
      packageGlobs: workspaceGlobs.length ? workspaceGlobs : ['packages/*', 'apps/*'],
      aliases: parsed.workspace?.aliases ?? {},
      defaultTarget: parsed.workspace?.defaultTarget ?? '',
      includeRoot: parsed.workspace?.includeRoot ?? true,
    },
    dotenv: {
      order: parsed.dotenv?.order ?? ['.env', '.env.{build}'],
      localBuildName: parsed.dotenv?.localBuildName ?? 'local',
      localOverrideFile: parsed.dotenv?.localOverrideFile ?? '.env.local',
      requireOverride: parsed.dotenv?.requireOverride ?? false,
      includeProcessEnv: parsed.dotenv?.includeProcessEnv ?? true,
    },
    vault: {
      enabled: parsed.vault?.enabled ?? false,
      disableUnsafeWarning: parsed.vault?.disableUnsafeWarning ?? false,
      configFile: parsed.vault?.configFile ?? 'env-lane.vault.json',
    },
    sort: parsed.sort,
  }
}
