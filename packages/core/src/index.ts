// Stable configuration and use-case API.
// biome-ignore assist/source/organizeImports: Public exports are grouped by stability and migration status.
export { type CheckResult, checkDotenvSelector } from './check.js'
export { defineConfig, loadEnvLaneConfig } from './config.js'
export { listEnvFiles, resolveInjectedEnv } from './dotenv.js'
export { EnvLaneError, errorCode } from './errors.js'
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
} from './logger.js'
export {
  type EnvCheckFinding,
  type EnvCheckResult,
  type EnvSyncResult,
  defineEnvCheck,
  defineEnvSync,
  runEnvCheck,
  runEnvSync,
} from './policy.js'
export {
  type RedactOptions,
  isSecretLikeKey,
  isSecretLikeValue,
  redactObject,
  redactRecord,
  redactValue,
  shouldRedact,
} from './redaction.js'
export { runWithInjectedEnv } from './run.js'
export {
  sortEnvFile,
  sortEnvFilesFromConfig,
} from './sort.js'
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
} from './types.js'
export {
  ALL_ENV_FILE_VARIANTS,
  DEFAULT_ENV_FILE_VARIANT,
  type EnvFileVariant,
  formatEnvFileVariant,
  normalizeEnvFileVariant,
} from './variants.js'
export { listWorkspacePackages, resolveTargetPackage } from './workspace.js'

/**
 * Compatibility exports for configuration internals. These remain available during the
 * boundary migration, but new consumers should use the stable configuration API above.
 *
 * @deprecated Not part of the stable root API.
 */
export {
  type LoadConfigOptionsWithC12,
  findWorkspaceRoot,
  loadConfigWithC12,
  readPnpmWorkspaceGlobs,
} from './config.js'

/**
 * Compatibility exports for resolved-input helpers.
 *
 * @deprecated Not part of the stable root API.
 */
export { listEnvFilesForTarget, resolveBuildName } from './dotenv.js'

/**
 * Compatibility root exports for the dotenv document feature. New consumers should import
 * these symbols from `@env-lane/core/env-document`.
 *
 * @deprecated Import from `@env-lane/core/env-document` instead.
 */
export {
  type EnvDocumentPatch,
  type EnvDocumentPatchResult,
  type EnvDocumentWriteResult,
  type EnvLine,
  type EnvLineData,
  type EnvTextDocument,
  type LoadedEnvDocument,
  applyEnvDocumentPatches,
  createEnvTextDocument,
  formatEnvValue,
  isEnvEntryLikeLine,
  isEnvEntryLine,
  loadEnvDocument,
  parseEnvDocument,
  parseEnvLine,
  renderEnvTextDocument,
  setEnvDocumentValues,
  writeEnvDocumentContent,
  writeEnvDocumentLines,
} from './env-document.js'

/**
 * Compatibility export for the current Node file adapter.
 *
 * @deprecated Not part of the stable root API.
 */
export { writeFileContentAtomically } from './file-utils.js'

/**
 * Compatibility exports for the current sort planner. File-oriented sorting remains available
 * through `sortEnvFile` and `sortEnvFilesFromConfig`.
 *
 * @deprecated Not part of the stable root API.
 */
export { type EnvSortPlan, type SortOperationAction, buildEnvSortPlan } from './sort.js'

/**
 * Compatibility exports for workspace orchestration internals.
 *
 * @deprecated Not part of the stable root API.
 */
export {
  listWorkspacePackagesForConfig,
  resolveTargetPackageFromList,
} from './workspace.js'
