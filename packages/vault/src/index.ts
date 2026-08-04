// Stable configuration and automation API.
// biome-ignore assist/source/organizeImports: Public exports are grouped by stability and migration status.
export { type EncryptOptions, encryptEnvFiles } from './application/push.js'
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
} from './application/restore.js'
export { pruneVaultHistory, sanitizeVaultHistory } from './application/storage.js'
export { type VaultConfig, defineVaultConfig, loadVaultConfig } from './adapters/config.js'
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
} from './domain/types.js'
export { VAULT_UNSAFE_WARNING, warnUnsafeVault } from './cli/warning.js'

/**
 * Breaking-release compatibility bridge for the optional CLI adapter at the package root.
 *
 * @deprecated Since 0.4.0. Import from `@env-lane/vault/cli` instead. This root re-export is
 * planned for removal in the next intentionally breaking release.
 */
export { type VaultCliContext, registerVaultCommands } from './cli/index.js'

/**
 * Breaking-release compatibility bridge for cryptographic implementation details. These functions
 * are not a supported record-format or key-management API.
 *
 * @deprecated Since 0.4.0. Planned for removal in the next intentionally breaking release;
 * not part of the stable Vault automation API.
 */
export {
  decryptRecord,
  deriveVaultKey,
  deriveVaultSyncKey,
  encryptRecord,
  keyedDigest,
  stableHash,
} from './adapters/crypto.js'
