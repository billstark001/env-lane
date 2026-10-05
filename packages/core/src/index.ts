// Stable configuration and use-case API.
// biome-ignore assist/source/organizeImports: Public exports are grouped by stability and migration status.
export { type CheckResult, checkDotenvSelector } from './application/native-check.js'
export { listEnvFiles, resolveInjectedEnv } from './application/dotenv.js'
export {
  type EnvCheckFinding,
  type EnvCheckResult,
  type EnvSyncResult,
  defineEnvCheck,
  defineEnvSync,
} from './application/policy.js'
export { runEnvCheck, runEnvSync } from './application/native-policy.js'
export { runWithInjectedEnv } from './application/run.js'
export { sortEnvFile, sortEnvFilesFromConfig } from './application/native-sort.js'
export { listWorkspacePackages, resolveTargetPackage } from './application/workspace.js'
export { defineConfig, loadEnvLaneConfig } from './adapters/config.js'
export {
  type Diagnostic,
  type DiagnosticFormatOptions,
  type DiagnosticLevel,
  type DiagnosticLogger,
  type DiagnosticScope,
  type EnvLaneContext,
  emitDiagnostic,
  formatDiagnostic,
  withEnvLaneContext,
} from './adapters/logger.js'
export { EnvLaneError, errorCode } from './domain/errors.js'
export {
  DEFAULT_MIN_REDACTION_LENGTH,
  type RedactOptions,
  isHighEntropyString,
  isJwt,
  isPaseto,
  isSecretLikeKey,
  isSecretLikeValue,
  redactObject,
  redactRecord,
  redactValue,
  shouldRedact,
} from './domain/redaction.js'
export type {
  EnvCheckConfig,
  EnvCheckRuleConfig,
  EnvCheckSeverity,
  EnvFileRef,
  EnvLaneConfig,
  EnvLaneOutputFormat,
  EnvSortTargetConfig,
  EnvSource,
  EnvSyncConfig,
  EnvSyncMappingConfig,
  EnvValueSourceConfig,
  EnvValueTargetConfig,
  EnvValueTransform,
  ResolvedEnv,
  ResolvedEnvLaneConfig,
  ResolveEnvOptions,
  WorkspacePackage,
} from './domain/types.js'
export {
  ALL_ENV_FILE_VARIANTS,
  DEFAULT_ENV_FILE_VARIANT,
  type EnvFileVariant,
  formatEnvFileVariant,
  normalizeEnvFileVariant,
} from './domain/variants.js'
