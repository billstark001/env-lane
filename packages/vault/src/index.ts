// Stable configuration and automation API.
// biome-ignore assist/source/organizeImports: Public exports are grouped by stability and migration status.
export { type VaultConfig, defineVaultConfig, loadVaultConfig } from './config.js'
export { type EncryptOptions, encryptEnvFiles } from './push.js'
export {
  type ApprovalDocument,
  type VaultFailCondition,
  type VaultSelectionOptions,
  applyRestorePlan,
  buildDefaultRestoreDecisions,
  buildRestorePlan,
  createApprovalDocument,
  decryptEnvFiles,
  hasUnresolvedSelectedConflict,
  matchesVaultPushSelection,
  matchesVaultSelection,
  parseVaultFailCondition,
  readApprovalDocument,
  restorePlanMatchesFailCondition,
  selectRestorePlan,
  selectRestorePlanByDecisions,
  writeApprovalDocument,
} from './restore.js'
export { pruneVaultHistory, sanitizeVaultHistory } from './storage.js'
export type {
  RestoreAction,
  RestoreDecision,
  RestoreDecisionChoice,
  RestorePlan,
  RestorePlanEntry,
  RestorePlanFile,
  VaultConflictStrategy,
  VaultOperation,
  VaultRecord,
} from './types.js'
export { VAULT_UNSAFE_WARNING, warnUnsafeVault } from './warning.js'

/**
 * Compatibility root export for the optional CLI adapter. New consumers should import it from
 * `@env-lane/vault/cli`.
 *
 * @deprecated Import from `@env-lane/vault/cli` instead.
 */
export { type VaultCliContext, registerVaultCommands } from './cli/index.js'

/**
 * Compatibility exports for cryptographic implementation details. They remain available during
 * the boundary migration but are not part of the stable Vault automation API.
 *
 * @deprecated Not part of the stable root API.
 */
export {
  decryptRecord,
  deriveVaultKey,
  deriveVaultSyncKey,
  encryptRecord,
  keyedDigest,
  stableHash,
} from './crypto.js'
