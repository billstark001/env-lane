import type { EnvCheckRuleConfig, EnvCheckSeverity, EnvLaneConfig } from '../domain/types.js'
import type { EnvDocumentWriteResult } from './env-document.js'

/** One result from a configured environment check. */
export interface EnvCheckFinding {
  ok: boolean
  severity: EnvCheckSeverity
  type: EnvCheckRuleConfig['type']
  label: string
  message: string
}

/** Aggregate result of `runEnvCheck`, including warning and error counts. */
export interface EnvCheckResult {
  ok: boolean
  check: string
  build: string
  findings: EnvCheckFinding[]
  summary: { ok: number; warnings: number; errors: number }
}

/** Result of a configured sync; `write` is absent for a dry run. */
export interface EnvSyncResult {
  sync: string
  build: string
  targetFile: string
  changed: boolean
  dryRun: boolean
  mappings: Array<{
    from: string
    to: string
    value: string
    skipped: boolean
  }>
  write?: EnvDocumentWriteResult
}

/** Preserve the caller's check declaration and its inferred TypeScript type. */
export function defineEnvCheck(config: EnvLaneConfig['checks']): EnvLaneConfig['checks'] {
  return config
}

/** Preserve the caller's sync declaration and its inferred TypeScript type. */
export function defineEnvSync(config: EnvLaneConfig['sync']): EnvLaneConfig['sync'] {
  return config
}
