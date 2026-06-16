import {
  checkDotenvSelector,
  getLogger,
  listEnvFiles,
  listWorkspacePackages,
  redactValue,
  resolveInjectedEnv,
  resolveTargetPackage,
  runEnvCheck,
  runEnvSync,
  runWithInjectedEnv,
} from '@env-lane/core'
import type { Command } from 'commander'
import type { CliContext } from '../context.js'

function mergedOptions(ctx: CliContext, opts: Record<string, unknown>) {
  return { ...ctx.getGlobalOptions(), ...opts } as Record<string, any>
}

export function registerCoreCommands(program: Command, ctx: CliContext): void {
  ctx
    .addCommonOptions(program.command('packages'))
    .description(
      'List discovered workspace packages. Falls back to root in single-package projects.',
    )
    .action(async (opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const packages = await listWorkspacePackages({ cwd: allOpts.cwd, configFile: allOpts.config })
      const logger = getLogger()
      if (format === 'json') {
        logger.log(JSON.stringify(packages, null, 2))
      } else {
        for (const pkg of packages)
          logger.log(`${pkg.name ?? '<unnamed>'}\t${pkg.relativeDir}\t${pkg.aliases.join(',')}`)
      }
    })

  ctx
    .addCommonOptions(program.command('resolve-target <target>'))
    .description('Resolve a target alias/name/path to a package.')
    .action(async (target, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const resolved = await resolveTargetPackage(target, {
        cwd: allOpts.cwd,
        configFile: allOpts.config,
      })
      if (format === 'json') {
        getLogger().log(JSON.stringify(resolved, null, 2))
      } else {
        getLogger().log(`${resolved.name ?? '<unnamed>'} ${resolved.dir}`)
      }
    })

  ctx
    .addCommonOptions(program.command('files [target]'))
    .alias('env-files')
    .description('List dotenv files in injection order.')
    .option('--require-override', 'fail if selected override file is missing')
    .action(async (target, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      if (target === 'all') {
        const packages = await listWorkspacePackages({
          cwd: allOpts.cwd,
          configFile: allOpts.config,
        })
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
          getLogger().log(JSON.stringify(result, null, 2))
        } else {
          for (const entry of result) {
            getLogger().log(`# ${entry.target.name ?? entry.target.relativeDir}`)
            for (const file of entry.files)
              getLogger().log(
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
        getLogger().log(JSON.stringify(files, null, 2))
      } else {
        for (const file of files)
          getLogger().log(
            `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
          )
      }
    })

  ctx
    .addCommonOptions(program.command('print <target>'))
    .alias('env-json')
    .description('Print final injected environment for a target.')
    .option('--show-secrets', 'print secret-like values without redaction')
    .option(
      '--include-shell',
      'print all shell environment variables, not only dotenv keys and the selector',
    )
    .option('--no-process-env', 'do not merge process.env')
    .action(async (target, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
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
        getLogger().log(JSON.stringify(payload, null, 2))
      } else {
        for (const key of keys)
          getLogger().log(`${key}=${redactValue(key, resolved.values[key], allOpts.showSecrets)}`)
      }
    })

  ctx
    .addCommonOptions(
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
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
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

  ctx
    .addCommonOptions(program.command('check'))
    .description('Run a configured env policy check or target dotenv selector check.')
    .option('--policy <name>', 'configured env policy check name')
    .option('--target <target>', 'target for the built-in dotenv selector check')
    .option('--require-override', 'fail if selected override file is missing')
    .action(async (opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      if (allOpts.policy && allOpts.target) {
        throw new Error('Use either --policy or --target, not both.')
      }
      if (!allOpts.policy && !allOpts.target) {
        throw new Error('Missing check selection. Use --policy <name> or --target <target>.')
      }

      if (allOpts.policy) {
        const result = await runEnvCheck(allOpts.policy, {
          cwd: allOpts.cwd,
          configFile: allOpts.config,
          build: allOpts.build,
        })
        if (format === 'json') {
          getLogger().log(JSON.stringify(result, null, 2))
        } else {
          for (const finding of result.findings) {
            const prefix = finding.ok ? 'OK' : finding.severity.toUpperCase()
            getLogger().log(`[${prefix}] ${finding.message}`)
          }
          getLogger().log(
            `Summary: ${result.summary.ok} ok, ${result.summary.warnings} warnings, ${result.summary.errors} errors.`,
          )
        }
        if (!result.ok) process.exit(1)
        return
      }

      const result = await checkDotenvSelector({
        cwd: allOpts.cwd,
        configFile: allOpts.config,
        target: allOpts.target,
        build: allOpts.build,
        requireOverride: allOpts.requireOverride,
      })
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
        if (!result.ok) process.exit(1)
        return
      }

      if (!result.ok) {
        if (result.violations.length) {
          getLogger().error(
            `${result.selectorKey} must not be stored in dotenv files:\n${result.violations.map((v) => `  ${v.relativeFile}${v.line ? `:${v.line}` : ''}`).join('\n')}`,
          )
        }
        if (result.missingRequired.length) {
          getLogger().error(
            `Missing required env file(s):\n${result.missingRequired.map((file) => `  ${file.target}: ${file.relativeFile}`).join('\n')}`,
          )
        }
        process.exit(1)
      }
      getLogger().success(`[env-lane] OK: ${result.selectorKey} is absent from dotenv files.`)
    })

  ctx
    .addCommonOptions(program.command('sync <name>'))
    .description('Run a configured env value sync.')
    .option('--dry-run', 'show mapped values without writing files')
    .action(async (name, opts) => {
      const allOpts = mergedOptions(ctx, opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await runEnvSync(name, {
        cwd: allOpts.cwd,
        configFile: allOpts.config,
        build: allOpts.build,
        dryRun: allOpts.dryRun,
      })
      if (format === 'json') {
        getLogger().log(JSON.stringify(result, null, 2))
      } else {
        getLogger().log(
          `${result.dryRun ? 'Would sync' : 'Synced'} ${result.sync} -> ${result.targetFile}`,
        )
        for (const mapping of result.mappings) {
          getLogger().log(
            `  ${mapping.skipped ? 'skipped' : 'mapped '} ${mapping.from} -> ${mapping.to}`,
          )
        }
        if (!result.dryRun) getLogger().log(`  Changed: ${result.changed}`)
      }
    })
}
