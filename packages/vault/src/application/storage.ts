import path from 'node:path'
import type { VaultConfig } from '../adapters/config.js'
import { withFileLock } from '../adapters/file-lock.js'

/** Normalize file separators for portable Vault selection patterns. */
export function portable(file: string): string {
  return file.replace(/\\/g, '/').replaceAll(path.sep, '/')
}

/** Hold one cross-process lock while JS callbacks inspect a native preview and apply it. */
export function withVaultOperationLock<T>(
  config: VaultConfig,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(`${config.storePath}.operation`, operation)
}
