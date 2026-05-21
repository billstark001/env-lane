import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const schema = z.object({
  envFiles: z.array(z.string().min(1)),
  outputDir: z.string().min(1).default('.env-lane-vault'),
  outputFile: z.string().min(1).default('store.dat'),
  trackDeletions: z.boolean().default(true),
  exclude: z
    .array(
      z.object({
        files: z.array(z.string().min(1)).or(z.string().min(1)),
        keys: z.array(z.string().min(1)).or(z.string().min(1)),
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
    return {
      files: stringList(
        rule.files ?? rule.file ?? rule.filePattern ?? rule.filePatterns,
        `config.exclude[${index}].files`,
      ),
      keys: stringList(
        rule.keys ?? rule.key ?? rule.keyPattern ?? rule.keyPatterns,
        `config.exclude[${index}].keys`,
      ),
    }
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
  exclude: Array<{ files: string[]; keys: string[] }>
  sort?: Record<string, { file: string; template: string; files?: Record<string, string> }>
  disableUnsafeWarning: boolean
}

export function loadVaultConfig(configPath: string): VaultConfig {
  const abs = path.resolve(configPath)
  if (!existsSync(abs)) throw new Error(`Vault config does not exist: ${abs}`)
  const baseDir = path.dirname(abs)
  const raw = JSON.parse(readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Record<
    string,
    unknown
  >
  const parsed = schema.parse({
    ...raw,
    exclude: normalizeExclude(raw.exclude ?? raw.excludes),
  })
  const outputDir = path.resolve(baseDir, parsed.outputDir)
  const envFiles = uniqueResolvedFiles(baseDir, parsed.envFiles)
  const storePath = path.resolve(outputDir, parsed.outputFile)
  if (envFiles.includes(storePath)) {
    throw new Error('The vault store file must not overlap with any env file.')
  }
  return {
    baseDir,
    envFiles,
    outputDir,
    outputFile: parsed.outputFile,
    storePath,
    trackDeletions: parsed.trackDeletions,
    exclude: parsed.exclude.map((rule) => ({
      files: Array.isArray(rule.files) ? rule.files : [rule.files],
      keys: Array.isArray(rule.keys) ? rule.keys : [rule.keys],
    })),
    sort: parsed.sort,
    disableUnsafeWarning: parsed.disableUnsafeWarning ?? false,
  }
}
