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
  const parsed = schema.parse(JSON.parse(readFileSync(abs, 'utf8')))
  const outputDir = path.resolve(baseDir, parsed.outputDir)
  return {
    baseDir,
    envFiles: parsed.envFiles.map((file) => path.resolve(baseDir, file)),
    outputDir,
    outputFile: parsed.outputFile,
    storePath: path.resolve(outputDir, parsed.outputFile),
    trackDeletions: parsed.trackDeletions,
    exclude: parsed.exclude.map((rule) => ({
      files: Array.isArray(rule.files) ? rule.files : [rule.files],
      keys: Array.isArray(rule.keys) ? rule.keys : [rule.keys],
    })),
    sort: parsed.sort,
    disableUnsafeWarning: parsed.disableUnsafeWarning ?? false,
  }
}
