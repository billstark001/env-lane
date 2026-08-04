import type { Command } from 'commander'
import { registerVaultEncryptCommand } from './encrypt.js'
import { registerVaultHistoryCommands } from './history.js'
import { registerVaultRestoreCommands } from './restore.js'
import type { VaultCliContext } from './types.js'

export type { VaultCliContext } from './types.js'

/** Runtime handshake used by the optional env-lane CLI peer loader. */
export const VAULT_CLI_API_VERSION = 1

export function registerVaultCommands(program: Command, ctx: VaultCliContext): void {
  const vault = program
    .command('vault')
    .description('Optional unsafe development vault helpers. Requires @env-lane/vault.')
  registerVaultEncryptCommand(vault, ctx)
  registerVaultRestoreCommands(vault, ctx)
  registerVaultHistoryCommands(vault, ctx)
}
