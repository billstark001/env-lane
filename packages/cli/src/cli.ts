#!/usr/bin/env node
import {
  checkDotenvSelector,
  listEnvFiles,
  listWorkspacePackages,
  redactValue,
  resolveInjectedEnv,
  resolveTargetPackage,
  runWithInjectedEnv,
  sortEnvFile,
  sortEnvFilesFromConfig,
} from '@env-lane/core'
import { Command } from 'commander'

type VaultModule = typeof import('@env-lane/vault')

const program = new Command()
program
  .name('env-lane')
  .description('Workspace-aware dotenv injection and development vault tooling.')
  .version('0.1.0')
program.enablePositionalOptions()

function addCommonOptions(command: Command): Command {
  return command
    .option('-c, --config <file>', 'env-lane config file')
    .option('-b, --build <name>', 'build selector value')
    .option('--cwd <dir>', 'working directory')
}

async function loadVaultModule(): Promise<VaultModule> {
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
      throw new Error(
        'Vault commands require the optional @env-lane/vault package. Install it with: pnpm add -D @env-lane/vault',
      )
    }
    throw error
  }
}

program
  .command('packages')
  .description('List discovered workspace packages. Falls back to root in single-package projects.')
  .option('-c, --config <file>', 'env-lane config file')
  .option('--cwd <dir>', 'working directory')
  .option('--format <format>', 'json or text', 'text')
  .action(async (opts) => {
    const packages = await listWorkspacePackages({ cwd: opts.cwd, configFile: opts.config })
    if (opts.format === 'json') console.log(JSON.stringify(packages, null, 2))
    else
      for (const pkg of packages)
        console.log(`${pkg.name ?? '<unnamed>'}\t${pkg.relativeDir}\t${pkg.aliases.join(',')}`)
  })

addCommonOptions(program.command('resolve-target <target>'))
  .description('Resolve a target alias/name/path to a package.')
  .option('--format <format>', 'json or text', 'json')
  .action(async (target, opts) => {
    const resolved = await resolveTargetPackage(target, { cwd: opts.cwd, configFile: opts.config })
    console.log(
      opts.format === 'json'
        ? JSON.stringify(resolved, null, 2)
        : `${resolved.name ?? '<unnamed>'} ${resolved.dir}`,
    )
  })

addCommonOptions(program.command('files [target]'))
  .alias('env-files')
  .description('List dotenv files in injection order.')
  .option('--require-override', 'fail if selected override file is missing')
  .option('--format <format>', 'json or text', 'text')
  .action(async (target, opts) => {
    if (target === 'all') {
      const packages = await listWorkspacePackages({ cwd: opts.cwd, configFile: opts.config })
      const result = await Promise.all(
        packages.map(async (pkg) => ({
          target: pkg,
          files: await listEnvFiles({
            cwd: opts.cwd,
            configFile: opts.config,
            target: pkg.relativeDir,
            build: opts.build,
            requireOverride: opts.requireOverride,
          }),
        })),
      )
      if (opts.format === 'json') console.log(JSON.stringify(result, null, 2))
      else {
        for (const entry of result) {
          console.log(`# ${entry.target.name ?? entry.target.relativeDir}`)
          for (const file of entry.files)
            console.log(
              `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
            )
        }
      }
      return
    }
    const files = await listEnvFiles({
      cwd: opts.cwd,
      configFile: opts.config,
      target,
      build: opts.build,
      requireOverride: opts.requireOverride,
    })
    if (opts.format === 'json') console.log(JSON.stringify(files, null, 2))
    else
      for (const file of files)
        console.log(
          `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
        )
  })

addCommonOptions(program.command('print <target>'))
  .alias('env-json')
  .description('Print final injected environment for a target.')
  .option('--format <format>', 'dotenv or json', 'dotenv')
  .option('--show-secrets', 'print secret-like values without redaction')
  .option(
    '--include-shell',
    'print all shell environment variables, not only dotenv keys and the selector',
  )
  .option('--no-process-env', 'do not merge process.env')
  .action(async (target, opts) => {
    const resolved = await resolveInjectedEnv({
      cwd: opts.cwd,
      configFile: opts.config,
      target,
      build: opts.build,
      includeProcessEnv: opts.processEnv,
    })
    const keys = Object.keys(resolved.values)
      .filter(
        (key) =>
          opts.includeShell ||
          resolved.sources[key]?.source !== 'process' ||
          resolved.sources[key]?.shellOverride,
      )
      .sort()
    if (opts.format === 'json') {
      const payload = Object.fromEntries(
        keys.map((key) => [
          key,
          {
            value: redactValue(key, resolved.values[key], opts.showSecrets),
            source: resolved.sources[key],
          },
        ]),
      )
      console.log(JSON.stringify(payload, null, 2))
    } else {
      for (const key of keys)
        console.log(`${key}=${redactValue(key, resolved.values[key], opts.showSecrets)}`)
    }
  })

addCommonOptions(
  program
    .command('run <target>')
    .argument('<command...>', 'command and arguments to run')
    .allowUnknownOption(true)
    .passThroughOptions(),
)
  .description('Run a command with injected dotenv environment.')
  .option('--run-cwd <target|root|path>', 'command working directory', 'target')
  .option('--quiet', 'suppress run summary')
  .action(async (target, command, opts) => {
    const code = await runWithInjectedEnv({
      cwd: opts.cwd,
      configFile: opts.config,
      target,
      build: opts.build,
      command,
      runCwd: opts.runCwd,
      quiet: opts.quiet,
    })
    process.exit(code)
  })

addCommonOptions(program.command('check [target]'))
  .description('Check that the selector key is not stored in dotenv files.')
  .option('--require-override', 'fail if selected override file is missing')
  .action(async (target, opts) => {
    const result = await checkDotenvSelector({
      cwd: opts.cwd,
      configFile: opts.config,
      target,
      build: opts.build,
      requireOverride: opts.requireOverride,
    })
    if (!result.ok) {
      if (result.violations.length) {
        console.error(
          `${result.selectorKey} must not be stored in dotenv files:\n${result.violations.map((v) => `  ${v.relativeFile}${v.line ? `:${v.line}` : ''}`).join('\n')}`,
        )
      }
      if (result.missingRequired.length) {
        console.error(
          `Missing required env file(s):\n${result.missingRequired.map((file) => `  ${file.target}: ${file.relativeFile}`).join('\n')}`,
        )
      }
      process.exit(1)
    }
    console.log(`[env-lane] OK: ${result.selectorKey} is absent from dotenv files.`)
  })

const vault = program
  .command('vault')
  .description('Optional unsafe development vault helpers. Requires @env-lane/vault.')
vault.command('encrypt <config> <keyFile>').action(async (config, keyFile) => {
  const { encryptEnvFiles } = await loadVaultModule()
  console.log(JSON.stringify(await encryptEnvFiles(config, keyFile), null, 2))
})
vault
  .command('plan <config> <keyFile>')
  .description('Print the vault restore plan without writing files.')
  .action(async (config, keyFile) => {
    const { buildRestorePlan } = await loadVaultModule()
    console.log(JSON.stringify(await buildRestorePlan(config, keyFile), null, 2))
  })
vault
  .command('decrypt <config> <keyFile>')
  .option('--dry-run', 'show planned restore without writing files')
  .option('-y, --yes', 'apply restore without interactive confirmation')
  .action(async (config, keyFile, opts) => {
    const { decryptEnvFiles } = await loadVaultModule()
    console.log(
      JSON.stringify(
        await decryptEnvFiles(config, keyFile, { dryRun: opts.dryRun, autoApprove: opts.yes }),
        null,
        2,
      ),
    )
  })

program
  .command('sort-file <envFile> <templateFile>')
  .description('Sort one env file using a template env file.')
  .action(async (envFile, templateFile) =>
    console.log(JSON.stringify(await sortEnvFile(envFile, templateFile), null, 2)),
  )
program
  .command('sort <config> [key] [envSuffix]')
  .description('Sort env files using vault config sort section.')
  .action(async (config, key = 'all', envSuffix = 'all') =>
    console.log(JSON.stringify(await sortEnvFilesFromConfig(config, key, envSuffix), null, 2)),
  )

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
