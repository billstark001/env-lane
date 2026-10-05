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
export { pruneVaultHistory, sanitizeVaultHistory } from './application/native-history.js'
export { type VaultConfig, defineVaultConfig, loadVaultConfig } from './adapters/config.js'
export type {
  RestoreAction,
  RestoreDecision,
  RestoreDecisionChoice,
  RestorePlan,
  RestorePlanEntry,
  RestorePlanFile,
  VaultConflictStrategy,
  VaultMissingFileStrategy,
  VaultOperation,
  VaultRecord,
  VaultRestoreRedaction,
  VaultRestoreReveal,
} from './domain/types.js'
export { VAULT_UNSAFE_WARNING, warnUnsafeVault } from './cli/warning.js'
