import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig as c12LoadConfig } from 'c12'
import { findUp } from 'find-up'
import YAML from 'yaml'
import { z } from 'zod'
import { EnvLaneError } from '../domain/errors.js'
import type { EnvLaneConfig, ResolvedEnvLaneConfig } from '../domain/types.js'

const sortTargetSchema = z.object({
  baseDir: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  template: z.string().min(1).optional(),
  files: z.record(z.string(), z.string().min(1)).optional(),
  create: z.boolean().optional(),
  unlistedVariablesComment: z.string().optional(),
})

const valueSourceSchema = z
  .object({
    target: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    includeProcessEnv: z.boolean().optional(),
  })
  .refine((source) => Number(Boolean(source.target)) + Number(Boolean(source.file)) === 1, {
    message: 'source must include target or file, but not both',
  })

const syncTargetSchema = z
  .object({
    target: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    includeProcessEnv: z.boolean().optional(),
    variant: z.string().min(1).optional(),
  })
  .refine((source) => Number(Boolean(source.target)) + Number(Boolean(source.file)) === 1, {
    message: 'source must include target or file, but not both',
  })

const checkRuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('required'),
    source: z.string().min(1),
    key: z.string().min(1),
    label: z.string().min(1).optional(),
    severity: z.enum(['warn', 'error']).optional(),
  }),
  z.object({
    type: z.literal('requiredAny'),
    source: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
    label: z.string().min(1).optional(),
    severity: z.enum(['warn', 'error']).optional(),
  }),
  z.object({
    type: z.literal('equals'),
    left: z.object({ source: z.string().min(1), key: z.string().min(1) }),
    right: z.object({ source: z.string().min(1), key: z.string().min(1) }),
    label: z.string().min(1).optional(),
    severity: z.enum(['warn', 'error']).optional(),
    transform: z.enum(['trim', 'lowercase', 'uppercase', 'url-base', 'url-base-slash']).optional(),
  }),
])

const syncSchema = z.object({
  from: valueSourceSchema,
  to: syncTargetSchema,
  mappings: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        transform: z
          .enum(['trim', 'lowercase', 'uppercase', 'url-base', 'url-base-slash'])
          .optional(),
      }),
    )
    .min(1),
})

const schema = z
  .object({
    selector: z
      .object({
        envKey: z.string().min(1).optional(),
        defaultBuild: z.string().min(1).optional(),
        builds: z.array(z.string().min(1)).optional(),
        buildValidation: z.enum(['off', 'warn', 'error']).optional(),
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
        preserveBOM: z.boolean().optional(),
        eol: z.enum(['auto', 'lf', 'crlf']).optional(),
      })
      .optional(),
    vault: z
      .object({
        enabled: z.boolean().optional(),
        disableUnsafeWarning: z.boolean().optional(),
        configFile: z.string().min(1).optional(),
      })
      .optional(),
    output: z
      .object({
        format: z.enum(['text', 'json', 'dotenv']).optional(),
        prefix: z.boolean().optional(),
      })
      .optional(),
    sort: z.record(z.string(), sortTargetSchema).optional(),
    checks: z
      .record(
        z.string(),
        z.object({
          sources: z.record(z.string(), valueSourceSchema),
          rules: z.array(checkRuleSchema),
        }),
      )
      .optional(),
    sync: z.record(z.string(), syncSchema).optional(),
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

export interface LoadConfigOptionsWithC12 {
  cwd?: string
  configFile?: string
  name: string
  configFileRequired?: boolean
}

export async function loadConfigWithC12<T extends object>(
  options: LoadConfigOptionsWithC12,
): Promise<{ config: T; configFile?: string; rootDir: string }> {
  const rootDir = await findWorkspaceRoot(options.cwd)
  const configFileName = options.configFile
    ? path.relative(rootDir, path.resolve(rootDir, options.configFile))
    : undefined

  const loaded = await c12LoadConfig<T>({
    name: options.name,
    cwd: rootDir,
    configFile: configFileName,
    packageJson: false,
    dotenv: false,
    rcFile: false,
    globalRc: false,
    configFileRequired: options.configFileRequired ?? false,
  })

  return {
    config: loaded.config as T,
    configFile: loaded.configFile,
    rootDir,
  }
}

async function loadEnvLaneConfigUnchecked(
  options: { cwd?: string; configFile?: string } = {},
): Promise<ResolvedEnvLaneConfig> {
  const { config, rootDir } = await loadConfigWithC12<EnvLaneConfig>({
    cwd: options.cwd,
    configFile: options.configFile,
    name: 'env-lane',
  })
  const parsed = schema.parse(config ?? {})
  const workspaceGlobs = parsed.workspace?.packageGlobs ?? readPnpmWorkspaceGlobs(rootDir) ?? []
  return {
    rootDir,
    selector: {
      envKey: parsed.selector?.envKey ?? 'ENV_BUILD',
      defaultBuild: parsed.selector?.defaultBuild ?? 'local',
      builds: parsed.selector?.builds ?? [],
      buildValidation: parsed.selector?.buildValidation ?? 'warn',
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
      preserveBOM: parsed.dotenv?.preserveBOM ?? true,
      eol: parsed.dotenv?.eol ?? 'auto',
    },
    vault: {
      enabled: parsed.vault?.enabled ?? false,
      disableUnsafeWarning: parsed.vault?.disableUnsafeWarning ?? false,
      configFile: parsed.vault?.configFile ?? 'env-lane.vault',
    },
    output: {
      format: parsed.output?.format ?? 'text',
      prefix: parsed.output?.prefix ?? true,
    },
    sort: parsed.sort,
    checks: parsed.checks as EnvLaneConfig['checks'],
    sync: parsed.sync as EnvLaneConfig['sync'],
  }
}

export async function loadEnvLaneConfig(
  options: { cwd?: string; configFile?: string } = {},
): Promise<ResolvedEnvLaneConfig> {
  try {
    return await loadEnvLaneConfigUnchecked(options)
  } catch (error) {
    if (error instanceof EnvLaneError) throw error
    const cause = error instanceof Error ? error.message : String(error)
    throw new EnvLaneError('CONFIG_LOAD_FAILED', `Failed to load env-lane config: ${cause}`, {
      cause,
      configFile: options.configFile,
    })
  }
}
