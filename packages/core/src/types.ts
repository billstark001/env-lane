export type EnvLaneOutputFormat = 'text' | 'json' | 'dotenv'

export interface EnvSortTargetConfig {
  baseDir?: string
  file?: string
  template?: string
  files?: Record<string, string>
  create?: boolean
}

export interface EnvValueSourceConfig {
  target?: string
  file?: string
  includeProcessEnv?: boolean
}

export type EnvCheckSeverity = 'warn' | 'error'
export type EnvValueTransform = 'trim' | 'lowercase' | 'uppercase' | 'url-base' | 'url-base-slash'

export type EnvCheckRuleConfig =
  | {
      type: 'required'
      source: string
      key: string
      label?: string
      severity?: EnvCheckSeverity
    }
  | {
      type: 'requiredAny'
      source: string
      keys: string[]
      label?: string
      severity?: EnvCheckSeverity
    }
  | {
      type: 'equals'
      left: { source: string; key: string }
      right: { source: string; key: string }
      label?: string
      severity?: EnvCheckSeverity
      transform?: EnvValueTransform
    }

export interface EnvCheckConfig {
  sources: Record<string, EnvValueSourceConfig>
  rules: EnvCheckRuleConfig[]
}

export interface EnvSyncMappingConfig {
  from: string
  to: string
  transform?: EnvValueTransform
}

export interface EnvSyncConfig {
  from: EnvValueSourceConfig
  to: EnvValueSourceConfig & { variant?: string }
  mappings: EnvSyncMappingConfig[]
}

export interface EnvLaneConfig {
  selector?: {
    /** Environment selector variable. Defaults to ENV_BUILD. */
    envKey?: string
    /** Default build name when no CLI/API build is supplied. Defaults to local. */
    defaultBuild?: string
    /** List of valid build names. If empty, all builds are allowed. */
    builds?: string[]
    /** How to handle a build outside selector.builds. Defaults to warn. */
    buildValidation?: 'off' | 'warn' | 'error'
    /** Forbid selector envKey in dotenv files. Defaults to true. */
    forbidInDotenv?: boolean
  }
  workspace?: {
    /** Optional package globs. Defaults to pnpm-workspace.yaml, then packages/* and apps/*. */
    packageGlobs?: string[]
    /** Additional aliases, keyed by alias, value package name or relative directory. */
    aliases?: Record<string, string>
    /** Default target when multiple packages exist. Defaults to error. */
    defaultTarget?: string
    /** Whether root is exposed as a target. Defaults to true. */
    includeRoot?: boolean
  }
  dotenv?: {
    /** Ordered dotenv patterns relative to target dir. {build} is interpolated. */
    order?: string[]
    /** Build name that maps to localOverrideFile. Defaults to local. */
    localBuildName?: string
    /** Override file for local build. Defaults to .env.local. */
    localOverrideFile?: string
    /** Fail if the selected override file is missing. Defaults to false. */
    requireOverride?: boolean
    /** Merge process.env after dotenv files. Defaults to true. */
    includeProcessEnv?: boolean
    /** Preserve UTF-8 BOM when writing environment files. Defaults to true. */
    preserveBOM?: boolean
    /** EOL format when writing files. Defaults to auto. */
    eol?: 'auto' | 'lf' | 'crlf'
  }
  cli?: {
    /** Custom CLI command aliases. */
    aliases?: Record<string, string>
  }
  vault?: {
    enabled?: boolean
    disableUnsafeWarning?: boolean
    configFile?: string
  }
  output?: {
    /** Default output format for CLI. */
    format?: EnvLaneOutputFormat
    /** Whether to include log prefixes. Defaults to true. */
    prefix?: boolean
  }
  sort?: Record<string, EnvSortTargetConfig>
  checks?: Record<string, EnvCheckConfig>
  sync?: Record<string, EnvSyncConfig>
}

export interface ResolvedEnvLaneConfig {
  rootDir: string
  selector: Required<NonNullable<EnvLaneConfig['selector']>>
  workspace: Required<Omit<NonNullable<EnvLaneConfig['workspace']>, 'aliases'>> & {
    aliases: Record<string, string>
  }
  dotenv: Required<NonNullable<EnvLaneConfig['dotenv']>> & {
    preserveBOM: boolean
    eol: 'auto' | 'lf' | 'crlf'
  }
  cli?: {
    aliases: Record<string, string>
  }
  vault: Required<NonNullable<EnvLaneConfig['vault']>>
  output: Required<NonNullable<EnvLaneConfig['output']>> & { prefix: boolean }
  sort?: Record<string, EnvSortTargetConfig>
  checks?: Record<string, EnvCheckConfig>
  sync?: Record<string, EnvSyncConfig>
}

export interface WorkspacePackage {
  name?: string
  dir: string
  relativeDir: string
  aliases: string[]
  isRoot: boolean
}

export interface EnvFileRef {
  kind: 'base' | 'override' | 'custom'
  path: string
  relativePath: string
  exists: boolean
  required: boolean
  order: number
}

export interface EnvSource {
  source: 'dotenv' | 'process' | 'selector'
  file?: string
  relativeFile?: string
  line?: number
  shellOverride?: boolean
}

export interface ResolveEnvOptions {
  cwd?: string
  configFile?: string
  target?: string
  build?: string
  includeProcessEnv?: boolean
  requireOverride?: boolean
  redact?: boolean
  showSecrets?: boolean
}

export interface ResolvedEnv {
  rootDir: string
  target: WorkspacePackage
  build: string
  selectorKey: string
  files: EnvFileRef[]
  values: Record<string, string>
  sources: Record<string, EnvSource>
}
