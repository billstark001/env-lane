// Stable configuration and use-case API.
// biome-ignore assist/source/organizeImports: Public exports are grouped by stability and migration status.
export { type CheckResult, checkDotenvSelector } from './application/check.js'
export { listEnvFiles, resolveInjectedEnv } from './application/dotenv.js'
export {
  type EnvCheckFinding,
  type EnvCheckResult,
  type EnvSyncResult,
  defineEnvCheck,
  defineEnvSync,
  runEnvCheck,
  runEnvSync,
} from './application/policy.js'
export { runWithInjectedEnv } from './application/run.js'
export { sortEnvFile, sortEnvFilesFromConfig } from './application/sort.js'
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
  type RedactOptions,
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

/**
 * Breaking-release compatibility bridge for configuration internals. These remain in 0.4.x,
 * but new consumers should use `defineConfig` and `loadEnvLaneConfig` instead.
 *
 * @deprecated Since 0.4.0. Planned for removal in the next intentionally breaking release;
 * not part of the stable root API.
 */
export {
  type LoadConfigOptionsWithC12,
  findWorkspaceRoot,
  loadConfigWithC12,
  readPnpmWorkspaceGlobs,
} from './adapters/config.js'

/**
 * Breaking-release compatibility bridge for resolved-input helpers.
 *
 * @deprecated Since 0.4.0. Planned for removal in the next intentionally breaking release;
 * use `listEnvFiles` and pass the build through public options instead.
 */
export { listEnvFilesForTarget, resolveBuildName } from './application/dotenv.js'

/**
 * Breaking-release compatibility bridge for the dotenv document feature at the package root.
 *
 * @deprecated Since 0.4.0. Import from `@env-lane/core/env-document` instead. These root
 * re-exports are planned for removal in the next intentionally breaking release.
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
 * Breaking-release compatibility bridge for the current Node file adapter.
 *
 * @deprecated Since 0.4.0. Planned for removal in the next intentionally breaking release;
 * not part of the stable root API.
 */
export { writeFileContentAtomically } from './adapters/file-utils.js'

/**
 * Breaking-release compatibility bridge for the current sort planner. File-oriented sorting
 * remains available through `sortEnvFile` and `sortEnvFilesFromConfig`.
 *
 * @deprecated Since 0.4.0. Planned for removal in the next intentionally breaking release;
 * use the file-oriented sorting APIs for stable automation.
 */
export {
  type EnvSortPlan,
  type SortOperationAction,
  buildEnvSortPlan,
} from './application/sort.js'

/**
 * Breaking-release compatibility bridge for workspace orchestration internals.
 *
 * @deprecated Since 0.4.0. Planned for removal in the next intentionally breaking release;
 * use `listWorkspacePackages` and `resolveTargetPackage` instead.
 */
export {
  listWorkspacePackagesForConfig,
  resolveTargetPackageFromList,
} from './application/workspace.js'
