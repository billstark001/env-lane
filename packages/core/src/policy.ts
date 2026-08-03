import path from 'node:path'
import { loadEnvLaneConfig } from './config.js'
import { listEnvFilesForTarget, resolveBuildName, resolveInjectedEnv } from './dotenv.js'
import {
  type EnvDocumentWriteResult,
  loadEnvDocument,
  setEnvDocumentValues,
} from './env-document.js'
import type {
  EnvCheckConfig,
  EnvCheckRuleConfig,
  EnvCheckSeverity,
  EnvLaneConfig,
  EnvSyncConfig,
  EnvValueSourceConfig,
  EnvValueTransform,
  ResolvedEnvLaneConfig,
} from './types.js'
import { DEFAULT_ENV_FILE_VARIANT, normalizeEnvFileVariant } from './variants.js'
import { resolveTargetPackage } from './workspace.js'

interface LoadedValueSource {
  name: string
  values: Map<string, string>
  exists: boolean
  files: string[]
}

export interface EnvCheckFinding {
  ok: boolean
  severity: EnvCheckSeverity
  type: EnvCheckRuleConfig['type']
  label: string
  message: string
}

export interface EnvCheckResult {
  ok: boolean
  check: string
  build: string
  findings: EnvCheckFinding[]
  summary: { ok: number; warnings: number; errors: number }
}

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

function isBlank(value: unknown): boolean {
  return !String(value ?? '').trim()
}

function transformValue(value: string, transform?: EnvValueTransform): string {
  if (!transform) return String(value ?? '')
  const trimmed = String(value ?? '').trim()
  if (transform === 'trim') return trimmed
  if (transform === 'lowercase') return trimmed.toLowerCase()
  if (transform === 'uppercase') return trimmed.toUpperCase()
  if (transform === 'url-base') return trimmed.replace(/\/+$/, '')
  if (transform === 'url-base-slash') {
    const base = trimmed.replace(/\/+$/, '')
    return base ? `${base}/` : ''
  }
  return trimmed
}

async function loadSource(
  name: string,
  source: EnvValueSourceConfig,
  config: ResolvedEnvLaneConfig,
  options: { build?: string },
): Promise<LoadedValueSource> {
  if (source.file) {
    const filePath = path.resolve(
      config.rootDir,
      interpolateBuild(source.file, options.build ?? ''),
    )
    const doc = loadEnvDocument(filePath)
    return {
      name,
      values: new Map(
        [...doc.currentMap.entries()].map(([key, entry]) => [key, entry.effectiveValue]),
      ),
      exists: doc.exists,
      files: [filePath],
    }
  }

  if (!source.target) throw new Error(`Source '${name}' must include target or file.`)
  const resolved = await resolveInjectedEnv({
    cwd: config.rootDir,
    config,
    target: source.target,
    build: options.build,
    includeProcessEnv: source.includeProcessEnv ?? false,
  })
  return {
    name,
    values: new Map(
      Object.entries(resolved.values).filter(
        ([key]) => source.includeProcessEnv || resolved.sources[key]?.source === 'dotenv',
      ),
    ),
    exists: resolved.files.some((file) => file.exists),
    files: resolved.files.filter((file) => file.exists).map((file) => file.path),
  }
}

function interpolateBuild(pattern: string, build: string): string {
  return pattern.replaceAll('{build}', build).replaceAll('{variant}', build)
}

function finding(
  ok: boolean,
  rule: EnvCheckRuleConfig,
  label: string,
  message: string,
): EnvCheckFinding {
  return {
    ok,
    severity: rule.severity ?? 'error',
    type: rule.type,
    label,
    message,
  }
}

function sourceOrThrow(sources: Map<string, LoadedValueSource>, name: string): LoadedValueSource {
  const source = sources.get(name)
  if (!source) throw new Error(`Unknown env check source: ${name}`)
  return source
}

function evaluateRule(
  rule: EnvCheckRuleConfig,
  sources: Map<string, LoadedValueSource>,
): EnvCheckFinding {
  if (rule.type === 'required') {
    const source = sourceOrThrow(sources, rule.source)
    const value = source.values.get(rule.key)
    const label = rule.label ?? `${rule.source}.${rule.key} required`
    return finding(
      !isBlank(value),
      rule,
      label,
      isBlank(value)
        ? `${rule.source} missing required ${rule.key}`
        : `${rule.source} has ${rule.key}`,
    )
  }

  if (rule.type === 'requiredAny') {
    const source = sourceOrThrow(sources, rule.source)
    const foundKey = rule.keys.find((key) => !isBlank(source.values.get(key)))
    const label = rule.label ?? `${rule.source}.${rule.keys.join('|')} required`
    return finding(
      Boolean(foundKey),
      rule,
      label,
      foundKey
        ? `${rule.source} has ${foundKey}`
        : `${rule.source} missing required ${rule.keys.join(' or ')}`,
    )
  }

  const leftSource = sourceOrThrow(sources, rule.left.source)
  const rightSource = sourceOrThrow(sources, rule.right.source)
  const leftRaw = leftSource.values.get(rule.left.key) ?? ''
  const rightRaw = rightSource.values.get(rule.right.key) ?? ''
  const left = transformValue(leftRaw, rule.transform)
  const right = transformValue(rightRaw, rule.transform)
  const label =
    rule.label ?? `${rule.left.source}.${rule.left.key} == ${rule.right.source}.${rule.right.key}`
  if (isBlank(left) || isBlank(right)) {
    return finding(false, { ...rule, severity: rule.severity ?? 'warn' }, label, `${label} skipped`)
  }
  return finding(
    left === right,
    rule,
    label,
    left === right ? `${label} aligned` : `${label} mismatch`,
  )
}

function summarize(findings: EnvCheckFinding[]) {
  return findings.reduce(
    (summary, item) => {
      if (item.ok) summary.ok++
      else if (item.severity === 'warn') summary.warnings++
      else summary.errors++
      return summary
    },
    { ok: 0, warnings: 0, errors: 0 },
  )
}

export async function runEnvCheck(
  checkName: string,
  options: {
    cwd?: string
    configFile?: string
    build?: string
  } = {},
): Promise<EnvCheckResult> {
  const config = await loadEnvLaneConfig(options)
  const check = config.checks?.[checkName]
  if (!check) throw new Error(`Unknown env check '${checkName}'.`)
  const build = resolveBuildName(options, config.selector.envKey, config.selector.defaultBuild, {
    builds: config.selector.builds,
    mode: config.selector.buildValidation,
  })
  const sources = await loadCheckSources(check, config, build)
  const findings = check.rules.map((rule) => evaluateRule(rule, sources))
  const summary = summarize(findings)
  return { ok: summary.errors === 0, check: checkName, build, findings, summary }
}

async function loadCheckSources(
  check: EnvCheckConfig,
  config: ResolvedEnvLaneConfig,
  build: string,
): Promise<Map<string, LoadedValueSource>> {
  const sources = new Map<string, LoadedValueSource>()
  for (const [name, source] of Object.entries(check.sources)) {
    sources.set(name, await loadSource(name, source, config, { build }))
  }
  return sources
}

async function resolveSyncTargetFile(
  sync: EnvSyncConfig,
  config: ResolvedEnvLaneConfig,
  build: string,
): Promise<string> {
  const variant = normalizeEnvFileVariant(sync.to.variant ?? build, {
    fallback: build,
    fieldName: 'sync target variant',
  })
  if (sync.to.file) {
    const buildForPattern = variant === DEFAULT_ENV_FILE_VARIANT ? '' : variant
    return path.resolve(config.rootDir, interpolateBuild(sync.to.file, buildForPattern))
  }
  if (!sync.to.target) throw new Error('Sync target must include target or file.')
  const target = await resolveTargetPackage(sync.to.target, { cwd: config.rootDir, config })
  if (variant === DEFAULT_ENV_FILE_VARIANT) return path.join(target.dir, '.env')
  const files = listEnvFilesForTarget(config, target, { build: variant })
  return files.find((file) => file.order > 0)?.path ?? path.join(target.dir, `.env.${variant}`)
}

export async function runEnvSync(
  syncName: string,
  options: {
    cwd?: string
    configFile?: string
    build?: string
    dryRun?: boolean
  } = {},
): Promise<EnvSyncResult> {
  const config = await loadEnvLaneConfig(options)
  const sync = config.sync?.[syncName]
  if (!sync) throw new Error(`Unknown env sync '${syncName}'.`)
  const build = resolveBuildName(options, config.selector.envKey, config.selector.defaultBuild, {
    builds: config.selector.builds,
    mode: config.selector.buildValidation,
  })
  const source = await loadSource('from', sync.from, config, { build })
  const targetFile = await resolveSyncTargetFile(sync, config, build)
  const values = new Map<string, string>()
  const mappings = sync.mappings.map((mapping) => {
    const value = transformValue(source.values.get(mapping.from) ?? '', mapping.transform)
    const skipped = isBlank(value)
    if (!skipped) values.set(mapping.to, value)
    return { from: mapping.from, to: mapping.to, value, skipped }
  })
  if (options.dryRun) {
    return { sync: syncName, build, targetFile, changed: false, dryRun: true, mappings }
  }
  const write = setEnvDocumentValues(targetFile, values)
  return {
    sync: syncName,
    build,
    targetFile,
    changed: write.changed,
    dryRun: false,
    mappings,
    write,
  }
}

export function defineEnvCheck(config: EnvLaneConfig['checks']): EnvLaneConfig['checks'] {
  return config
}

export function defineEnvSync(config: EnvLaneConfig['sync']): EnvLaneConfig['sync'] {
  return config
}
