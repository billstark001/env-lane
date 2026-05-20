export type EnvLaneOutputFormat = 'json' | 'dotenv'

export interface EnvLaneConfig {
  selector?: {
    /** Environment selector variable. Defaults to ENV_BUILD. */
    envKey?: string
    /** Default build name when no CLI/API build is supplied. Defaults to local. */
    defaultBuild?: string
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
  }
  vault?: {
    enabled?: boolean
    disableUnsafeWarning?: boolean
    configFile?: string
  }
}

export interface ResolvedEnvLaneConfig {
  rootDir: string
  selector: Required<NonNullable<EnvLaneConfig['selector']>>
  workspace: Required<Omit<NonNullable<EnvLaneConfig['workspace']>, 'aliases'>> & {
    aliases: Record<string, string>
  }
  dotenv: Required<NonNullable<EnvLaneConfig['dotenv']>>
  vault: Required<NonNullable<EnvLaneConfig['vault']>>
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
