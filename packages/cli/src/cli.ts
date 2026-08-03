#!/usr/bin/env node
import { EnvLaneError, loadEnvLaneConfig, withEnvLaneContext } from '@env-lane/core'
import { Command, CommanderError } from 'commander'
import packageJson from '../package.json' with { type: 'json' }
import { applyCliAliases } from './aliases.js'
import { registerCoreCommands } from './commands/core.js'
import { registerSortCommands } from './commands/sort.js'
import { type CliContext, createCliContext } from './context.js'

type VaultCliModule = typeof import('@env-lane/vault')

const program = new Command()
program
  .name('env-lane')
  .description('Workspace-aware dotenv injection and development vault tooling.')
  .version(packageJson.version)
program.enablePositionalOptions()
program.exitOverride()
program.configureOutput({ writeErr: () => undefined })

const ctx = createCliContext(program)
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
  if (config.cli?.aliases) applyCliAliases(program, config.cli.aliases)
} catch {
  // ignore config load errors here
}

function wantsJson(command: Command): boolean {
  const options = command.opts<{ format?: string; json?: boolean }>()
  if (options.json || options.format === 'json') return true
  return command.commands.some((subcommand) => wantsJson(subcommand))
}

try {
  await withEnvLaneContext({ logger: ctx.logger }, () => program.parseAsync())
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0
  } else {
    const renderedError =
      error instanceof CommanderError
        ? new EnvLaneError('CLI_ARGUMENT_ERROR', error.message)
        : error
    const json = wantsJson(program)
    ctx.renderError(renderedError, json)
    process.exitCode = 1
  }
}
