#!/usr/bin/env node
import { EnvLaneError, withEnvLaneContext } from '@env-lane/core'
import { Command, CommanderError } from 'commander'
import packageJson from '../package.json' with { type: 'json' }
import { registerCoreCommands } from './presentation/commands/core.js'
import { registerSortCommands } from './presentation/commands/sort.js'
import { readCliBootstrapOptions } from './presentation/runtime/bootstrap-options.js'
import { type CliContext, createCliContext } from './presentation/runtime/context.js'

type VaultCliModule = typeof import('@env-lane/vault/cli')

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
    return await import('@env-lane/vault/cli')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      // Compatibility with Vault releases that predate the dedicated CLI subpath.
      return import('@env-lane/vault')
    }
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
          throw new EnvLaneError(
            'VAULT_NOT_INSTALLED',
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

let bootstrapJson = false
const argv = process.argv.slice(2)

// Apply output defaults before Commander handles argument errors.
try {
  const bootstrapOptions = readCliBootstrapOptions(argv)
  ctx.setDiagnosticPrefix(bootstrapOptions.prefix !== false)
  bootstrapJson = Boolean(bootstrapOptions.json || bootstrapOptions.format === 'json')
  bootstrapJson = (await ctx.resolveOutputFormat(bootstrapOptions)) === 'json'
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
    const json = wantsJson(program) || bootstrapJson
    ctx.renderError(renderedError, json)
    process.exitCode = 1
  }
}
