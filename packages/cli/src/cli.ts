#!/usr/bin/env node
import {
  checkDotenvSelector,
  listEnvFiles,
  listWorkspacePackages,
  loadEnvLaneConfig,
  redactValue,
  resolveInjectedEnv,
  resolveTargetPackage,
  runWithInjectedEnv,
  sortEnvFile,
  sortEnvFilesFromConfig,
} from '@env-lane/core'
import type { EnvLaneOutputFormat } from '@env-lane/core'
import { Command } from 'commander'

type VaultModule = typeof import('@env-lane/vault')

const program = new Command()
program
  .name('env-lane')
  .description('Workspace-aware dotenv injection and development vault tooling.')
  .version('0.1.0')
  .option('--format <format>', 'output format (text, json, dotenv)')
  .option('--json', 'use json output format (shorthand for --format json)')
program.enablePositionalOptions()

function addCommonOptions(command: Command): Command {
  return command
    .option('-c, --config <file>', 'env-lane config file')
    .option('-b, --build <name>', 'build selector value')
    .option('--cwd <dir>', 'working directory')
    .option('--format <format>', 'output format (text, json, dotenv)')
    .option('--json', 'use json output format (shorthand for --format json)')
}

async function resolveOutputFormat(
  opts: { format?: string; json?: boolean; config?: string; cwd?: string },
  defaultFormat: EnvLaneOutputFormat = 'text',
): Promise<EnvLaneOutputFormat> {
  if (opts.json) return 'json'
  if (opts.format) return opts.format as EnvLaneOutputFormat

  const config = await loadEnvLaneConfig({ configFile: opts.config, cwd: opts.cwd })
  return config.output.format ?? defaultFormat
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

addCommonOptions(program.command('packages'))
  .description('List discovered workspace packages. Falls back to root in single-package projects.')
  .action(async (opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'text')
    const packages = await listWorkspacePackages({ cwd: allOpts.cwd, configFile: allOpts.config })
    if (format === 'json') {
      console.log(JSON.stringify(packages, null, 2))
    } else {
      for (const pkg of packages)
        console.log(`${pkg.name ?? '<unnamed>'}\t${pkg.relativeDir}\t${pkg.aliases.join(',')}`)
    }
  })

addCommonOptions(program.command('resolve-target <target>'))
  .description('Resolve a target alias/name/path to a package.')
  .action(async (target, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'json')
    const resolved = await resolveTargetPackage(target, { cwd: allOpts.cwd, configFile: allOpts.config })
    if (format === 'json') {
      console.log(JSON.stringify(resolved, null, 2))
    } else {
      console.log(`${resolved.name ?? '<unnamed>'} ${resolved.dir}`)
    }
  })

addCommonOptions(program.command('files [target]'))
  .alias('env-files')
  .description('List dotenv files in injection order.')
  .option('--require-override', 'fail if selected override file is missing')
  .action(async (target, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'text')
    if (target === 'all') {
      const packages = await listWorkspacePackages({ cwd: allOpts.cwd, configFile: allOpts.config })
      const result = await Promise.all(
        packages.map(async (pkg) => ({
          target: pkg,
          files: await listEnvFiles({
            cwd: allOpts.cwd,
            configFile: allOpts.config,
            target: pkg.relativeDir,
            build: allOpts.build,
            requireOverride: allOpts.requireOverride,
          }),
        })),
      )
      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2))
      } else {
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
      cwd: allOpts.cwd,
      configFile: allOpts.config,
      target,
      build: allOpts.build,
      requireOverride: allOpts.requireOverride,
    })
    if (format === 'json') {
      console.log(JSON.stringify(files, null, 2))
    } else {
      for (const file of files)
        console.log(
          `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
        )
    }
  })

addCommonOptions(program.command('print <target>'))
  .alias('env-json')
  .description('Print final injected environment for a target.')
  .option('--show-secrets', 'print secret-like values without redaction')
  .option(
    '--include-shell',
    'print all shell environment variables, not only dotenv keys and the selector',
  )
  .option('--no-process-env', 'do not merge process.env')
  .action(async (target, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'dotenv')
    const resolved = await resolveInjectedEnv({
      cwd: allOpts.cwd,
      configFile: allOpts.config,
      target,
      build: allOpts.build,
      includeProcessEnv: allOpts.processEnv,
    })
    const keys = Object.keys(resolved.values)
      .filter(
        (key) =>
          allOpts.includeShell ||
          resolved.sources[key]?.source !== 'process' ||
          resolved.sources[key]?.shellOverride,
      )
      .sort()

    if (format === 'json') {
      const payload = Object.fromEntries(
        keys.map((key) => [
          key,
          {
            value: redactValue(key, resolved.values[key], allOpts.showSecrets),
            source: resolved.sources[key],
          },
        ]),
      )
      console.log(JSON.stringify(payload, null, 2))
    } else {
      // Both "text" and "dotenv" formats for 'print' result in KEY=VALUE pairs.
      // "dotenv" is specifically intended for shell sourcing or .env file generation.
      for (const key of keys)
        console.log(`${key}=${redactValue(key, resolved.values[key], allOpts.showSecrets)}`)
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
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'text')
    const code = await runWithInjectedEnv({
      cwd: allOpts.cwd,
      configFile: allOpts.config,
      target,
      build: allOpts.build,
      command,
      runCwd: allOpts.runCwd,
      quiet: allOpts.quiet || format === 'json',
    })
    process.exit(code)
  })

addCommonOptions(program.command('check [target]'))
  .description('Check that the selector key is not stored in dotenv files.')
  .option('--require-override', 'fail if selected override file is missing')
  .action(async (target, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'text')
    const result = await checkDotenvSelector({
      cwd: allOpts.cwd,
      configFile: allOpts.config,
      target,
      build: allOpts.build,
      requireOverride: allOpts.requireOverride,
    })
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
      return
    }

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
addCommonOptions(vault.command('encrypt <config> <keyFile>')).action(async (config, keyFile, opts) => {
  const allOpts = { ...program.opts(), ...opts }
  const format = await resolveOutputFormat(allOpts, 'json')
  const { encryptEnvFiles } = await loadVaultModule()
  const result = await encryptEnvFiles(config, keyFile)
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Encrypted records to ${result.storePath}`)
    console.log(`  Set: ${result.setRecordsWritten}`)
    console.log(`  Delete: ${result.deleteRecordsWritten}`)
    console.log(`  Skipped unchanged: ${result.skippedUnchanged}`)
  }
})
addCommonOptions(vault.command('plan <config> <keyFile>'))
  .description('Print the vault restore plan without writing files.')
  .action(async (config, keyFile, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'json')
    const { buildRestorePlan } = await loadVaultModule()
    const result = await buildRestorePlan(config, keyFile)
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Restore plan for ${result.storePath}:`)
      for (const file of result.files) {
        const changes = file.entries.filter((e) => e.action !== 'identical')
        if (changes.length > 0) {
          console.log(`# ${file.filePath}`)
          for (const e of changes) console.log(`  ${e.action.padEnd(10)} ${e.key}`)
        }
      }
      console.log(`Summary: ${result.summary.filesWithChanges} files to change.`)
    }
  })
addCommonOptions(vault.command('decrypt <config> <keyFile>'))
  .option('--dry-run', 'show planned restore without writing files')
  .option('-y, --yes', 'apply restore without interactive confirmation')
  .action(async (config, keyFile, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'json')
    const { decryptEnvFiles } = await loadVaultModule()
    const result = await decryptEnvFiles(config, keyFile, {
      dryRun: allOpts.dryRun,
      autoApprove: allOpts.yes,
    })
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Decrypted ${result.filesWritten} files from ${result.storePath}`)
    }
  })

addCommonOptions(program.command('sort-file <envFile> <templateFile>'))
  .description('Sort one env file using a template env file.')
  .action(async (envFile, templateFile, opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'json')
    const result = await sortEnvFile(envFile, templateFile)
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`${result.applied ? 'Sorted' : 'No changes for'} ${envFile}`)
      if (result.applied) {
        console.log(`  Moved: ${result.movedCount}`)
        console.log(`  Inserted commented: ${result.insertedCommentedCount}`)
      }
    }
  })
addCommonOptions(program.command('sort <config> [key] [envSuffix]'))
  .description('Sort env files using an env-lane config sort section.')
  .action(async (config, key = 'all', envSuffix = 'all', opts) => {
    const allOpts = { ...program.opts(), ...opts }
    const format = await resolveOutputFormat(allOpts, 'json')
    const result = await sortEnvFilesFromConfig(config, key, envSuffix)
    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Sort applied: ${result.applied}`)
      for (const r of result.results) {
        console.log(`${r.applied ? 'SORTED ' : 'SKIPPED'} ${r.filePath}`)
      }
    }
  })

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
