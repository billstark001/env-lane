import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfigWithC12, loadEnvLaneConfig, type ResolvedEnvLaneConfig } from '@env-lane/core'
import { z } from 'zod'

const schema = z.object({
  envFiles: z.array(z.string().min(1)),
  outputDir: z.string().min(1).default('.env-lane-vault'),
  outputFile: z.string().min(1).default('store.dat'),
  trackDeletions: z.boolean().default(true),
  autoRemapPaths: z.boolean().default(true),
  allowUnmanaged: z.boolean().default(false),
  exclude: z
    .array(
      z.object({
        files: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        file: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        filePattern: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        filePatterns: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        keys: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        key: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        keyPattern: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
        keyPatterns: z.array(z.string().min(1)).or(z.string().min(1)).optional(),
      }),
    )
    .default([]),
  sort: z
    .record(
      z.string(),
      z.object({
        file: z.string().min(1),
        template: z.string().min(1),
        files: z.record(z.string(), z.string().min(1)).optional(),
      }),
    )
    .optional(),
  disableUnsafeWarning: z.boolean().optional(),
})

function stringList(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return []
  const values = Array.isArray(value) ? value : [value]
  return values.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${fieldName} must contain non-empty strings.`)
    }
    return item.trim()
  })
}

function normalizeExclude(rawExclude: unknown): Array<{ files: string[]; keys: string[] }> {
  if (rawExclude === undefined) return []
  const rawRules: unknown[] = []

  if (Array.isArray(rawExclude)) {
    rawRules.push(...rawExclude)
  } else if (rawExclude && typeof rawExclude === 'object') {
    for (const [filePattern, keyPatterns] of Object.entries(rawExclude)) {
      rawRules.push({ files: [filePattern], keys: keyPatterns })
    }
  } else {
    throw new Error('config.exclude must be an array or an object when provided.')
  }

  return rawRules.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
      throw new Error(`config.exclude[${index}] must be an object.`)
    }
    const rule = rawRule as Record<string, unknown>
    const files = stringList(
      rule.files ?? rule.file ?? rule.filePattern ?? rule.filePatterns,
      `config.exclude[${index}].files`,
    )
    const keys = stringList(
      rule.keys ?? rule.key ?? rule.keyPattern ?? rule.keyPatterns,
      `config.exclude[${index}].keys`,
    )
    if (files.length === 0 || keys.length === 0) {
      throw new Error(
        `config.exclude[${index}] must define at least one file pattern and one key pattern for the local-only boundary.`,
      )
    }
    return { files, keys }
  })
}

function uniqueResolvedFiles(baseDir: string, files: string[]): string[] {
  return [...new Set(files.map((file) => path.resolve(baseDir, file)))]
}

export interface VaultConfig {
  baseDir: string
  envFiles: string[]
  outputDir: string
  outputFile: string
  storePath: string
  trackDeletions: boolean
  autoRemapPaths: boolean
  allowUnmanaged: boolean
  exclude: Array<{ files: string[]; keys: string[] }>
  sort?: Record<string, { file: string; template: string; files?: Record<string, string> }>
  disableUnsafeWarning: boolean
}

export function defineVaultConfig(config: z.input<typeof schema>): z.input<typeof schema> {
  return config
}

function isVaultConfig(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false
  return 'envFiles' in obj || 'outputDir' in obj || 'outputFile' in obj
}

export async function loadVaultConfig(
  configPath?: string,
  options?: {
    cwd?: string
    vaultConfigFile?: string
    autoRemapPaths?: boolean
    allowUnmanaged?: boolean
  },
): Promise<VaultConfig> {
  let mainConfigPath: string | undefined
  let vaultConfigPath: string | undefined = options?.vaultConfigFile

  if (configPath && !vaultConfigPath) {
    const resolvedPath = path.resolve(options?.cwd ?? process.cwd(), configPath)
    let rawConfig: any = null
    try {
      if (path.extname(resolvedPath) === '.json' && existsSync(resolvedPath)) {
        rawConfig = JSON.parse(readFileSync(resolvedPath, 'utf8').replace(/^\uFEFF/, ''))
      } else {
        const loaded = await loadConfigWithC12<Record<string, any>>({
          cwd: path.dirname(resolvedPath),
          configFile: resolvedPath,
          name: 'env-lane.vault',
        })
        rawConfig = loaded.config
      }
    } catch {
      // ignore
    }

    if (isVaultConfig(rawConfig)) {
      vaultConfigPath = configPath
    } else {
      mainConfigPath = configPath
    }
  } else if (configPath && vaultConfigPath) {
    mainConfigPath = configPath
  }

  let mainConfig: ResolvedEnvLaneConfig | undefined
  try {
    mainConfig = await loadEnvLaneConfig({ cwd: options?.cwd, configFile: mainConfigPath })
  } catch {
    // ignore
  }

  const baseDir = mainConfig?.rootDir ?? options?.cwd ?? process.cwd()
  let configFileToLoad: string

  if (vaultConfigPath) {
    configFileToLoad = path.resolve(baseDir, vaultConfigPath)
  } else if (mainConfig) {
    configFileToLoad = path.resolve(baseDir, mainConfig.vault.configFile)
  } else {
    configFileToLoad = path.resolve(baseDir, 'env-lane.vault')
  }

  const hasJsonExt = path.extname(configFileToLoad) === '.json'
  let raw: Record<string, unknown>

  if (hasJsonExt && existsSync(configFileToLoad)) {
    raw = JSON.parse(readFileSync(configFileToLoad, 'utf8').replace(/^\uFEFF/, '')) as Record<
      string,
      unknown
    >
  } else {
    const loaded = await loadConfigWithC12<Record<string, unknown>>({
      cwd: path.dirname(configFileToLoad),
      configFile: configFileToLoad,
      name: 'env-lane.vault',
      configFileRequired: true,
    })
    if (!loaded.configFile) {
      throw new Error(`Vault config does not exist: ${configFileToLoad}`)
    }
    configFileToLoad = loaded.configFile
    raw = loaded.config ?? {}
  }

  const baseDirOfConfig = path.dirname(configFileToLoad)
  const parsed = schema.parse({
    ...raw,
    exclude: normalizeExclude(raw.exclude ?? raw.excludes),
  })
  const outputDir = path.resolve(baseDirOfConfig, parsed.outputDir)
  const envFiles = uniqueResolvedFiles(baseDirOfConfig, parsed.envFiles)
  const storePath = path.resolve(outputDir, parsed.outputFile)
  if (envFiles.includes(storePath)) {
    throw new Error('The vault store file must not overlap with any env file.')
  }
  return {
    baseDir: baseDirOfConfig,
    envFiles,
    outputDir,
    outputFile: parsed.outputFile,
    storePath,
    trackDeletions: parsed.trackDeletions,
    autoRemapPaths: options?.autoRemapPaths ?? parsed.autoRemapPaths,
    allowUnmanaged: options?.allowUnmanaged ?? parsed.allowUnmanaged,
    exclude: parsed.exclude.map((rule) => ({
      files: Array.isArray(rule.files) ? rule.files : rule.files ? [rule.files] : [],
      keys: Array.isArray(rule.keys) ? rule.keys : rule.keys ? [rule.keys] : [],
    })),
    sort: parsed.sort,
    disableUnsafeWarning: parsed.disableUnsafeWarning ?? false,
  }
}
