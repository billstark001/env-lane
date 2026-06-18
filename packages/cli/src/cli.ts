#!/usr/bin/env node
import { getLogger, loadEnvLaneConfig, setLogger } from '@env-lane/core'
import { Command } from 'commander'
import { createConsola } from 'consola'
import packageJson from '../package.json' with { type: 'json' }
import { registerCoreCommands } from './commands/core.js'
import { registerSortCommands } from './commands/sort.js'
import { type CliContext, createCliContext } from './context.js'

type VaultCliModule = typeof import('@env-lane/vault')

const consola = createConsola()
setLogger({
  log: (msg, ...args) => consola.log(msg, ...args),
  info: (msg, ...args) => consola.info(msg, ...args),
  warn: (msg, ...args) => consola.warn(msg, ...args),
  error: (msg, ...args) => consola.error(msg, ...args),
  success: (msg, ...args) => consola.success(msg, ...args),
  debug: (msg, ...args) => consola.debug(msg, ...args),
  write: (msg) => process.stdout.write(msg),
})

const program = new Command()
program
  .name('env-lane')
  .description('Workspace-aware dotenv injection and development vault tooling.')
  .version(packageJson.version)
program.enablePositionalOptions()

const ctx = createCliContext(program, consola)
ctx.addCommonOptions(program)

async function loadVaultCliModule(): Promise<VaultCliModule | undefined> {
  try {
    return await import('@env-lane/vault')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' &&
      error instanceof Error &&
      error.message.includes('@env-lane/vault')
    ) {
      program
        .command('vault')
        .description('Optional unsafe development vault helpers. Requires @env-lane/vault.')
        .action(() => {
          throw new Error(
            'Vault commands require the optional @env-lane/vault package. Install it with: pnpm add -D @env-lane/vault',
          )
        })
      return undefined
    }
    throw error
  }
}

async function registerOptionalVaultCommands(command: Command, cliContext: CliContext) {
  const vault = await loadVaultCliModule()
  vault?.registerVaultCommands(command, cliContext)
}

registerCoreCommands(program, ctx)
registerSortCommands(program, ctx)
await registerOptionalVaultCommands(program, ctx)

// Apply custom CLI command aliases
try {
  const config = await loadEnvLaneConfig()
  if (config.cli?.aliases) {
    for (const [cmdName, alias] of Object.entries(config.cli.aliases)) {
      const cmd = program.commands.find((c) => c.name() === cmdName)
      if (cmd) {
        cmd.alias(alias)
      }
    }
  }
} catch {
  // ignore config load errors here
}

program.parseAsync().catch((error: unknown) => {
  getLogger().error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
