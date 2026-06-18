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

export function registerCoreCommands(program: Command, ctx: CliContext): void {
  ctx
    .addCommonOptions(program.command('packages'))
    .description(
      'List discovered workspace packages. Falls back to root in single-package projects.',
    )
    .action(async (opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const packages = await listWorkspacePackages({ cwd: allOpts.cwd, configFile: allOpts.config })
      ctx.formatAndLog(packages, {
        format,
        text: (pkgs) => {
          const logger = getLogger()
          for (const pkg of pkgs)
            logger.log(`${pkg.name ?? '<unnamed>'}\t${pkg.relativeDir}\t${pkg.aliases.join(',')}`)
        },
      })
    })

  ctx
    .addCommonOptions(program.command('resolve-target <target>'))
    .description('Resolve a target alias/name/path to a package.')
    .action(async (target, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const resolved = await resolveTargetPackage(target, {
        cwd: allOpts.cwd,
        configFile: allOpts.config,
      })
      ctx.formatAndLog(resolved, {
        format,
        text: (res) => {
          getLogger().log(`${res.name ?? '<unnamed>'} ${res.dir}`)
        },
      })
    })

  ctx
    .addCommonOptions(program.command('files [target]'))
    .alias('env-files')
    .description('List dotenv files in injection order.')
    .option('--require-override', 'fail if selected override file is missing')
    .action(async (target, opts) => {
      const allOpts = ctx.mergeOptions(opts)
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
        ctx.formatAndLog(result, {
          format,
          text: (res) => {
            for (const entry of res) {
              getLogger().log(`# ${entry.target.name ?? entry.target.relativeDir}`)
              for (const file of entry.files)
                getLogger().log(
                  `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
                )
            }
          },
        })
        return
      }
      const files = await listEnvFiles({
        cwd: allOpts.cwd,
        configFile: allOpts.config,
        target,
        build: allOpts.build,
        requireOverride: allOpts.requireOverride,
      })
      ctx.formatAndLog(files, {
        format,
        text: (res) => {
          for (const file of res)
            getLogger().log(
              `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
            )
        },
      })
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
      const allOpts = ctx.mergeOptions(opts)
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

      ctx.formatAndLog(resolved, {
        format,
        json: (res) => {
          return Object.fromEntries(
            keys.map((key) => [
              key,
              {
                value: redactValue(key, res.values[key], allOpts.showSecrets),
                source: res.sources[key],
              },
            ]),
          )
        },
        text: (res) => {
          for (const key of keys)
            getLogger().log(`${key}=${redactValue(key, res.values[key], allOpts.showSecrets)}`)
        },
      })
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
      const allOpts = ctx.mergeOptions(opts)
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
      const allOpts = ctx.mergeOptions(opts)
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
        ctx.formatAndLog(result, {
          format,
          text: (res) => {
            for (const finding of res.findings) {
              const prefix = finding.ok ? 'OK' : finding.severity.toUpperCase()
              getLogger().log(`[${prefix}] ${finding.message}`)
            }
            getLogger().log(
              `Summary: ${res.summary.ok} ok, ${res.summary.warnings} warnings, ${res.summary.errors} errors.`,
            )
          },
        })
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

      if (!result.ok) {
        if (format === 'json') {
          getLogger().log(JSON.stringify(result, null, 2))
        } else {
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
        }
        process.exit(1)
      }

      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          getLogger().success(`[env-lane] OK: ${res.selectorKey} is absent from dotenv files.`)
        },
      })
    })

  ctx
    .addCommonOptions(program.command('sync <name>'))
    .description('Run a configured env value sync.')
    .option('--dry-run', 'show mapped values without writing files')
    .action(async (name, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      const result = await runEnvSync(name, {
        cwd: allOpts.cwd,
        configFile: allOpts.config,
        build: allOpts.build,
        dryRun: allOpts.dryRun,
      })
      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          getLogger().log(
            `${res.dryRun ? 'Would sync' : 'Synced'} ${res.sync} -> ${res.targetFile}`,
          )
          for (const mapping of res.mappings) {
            getLogger().log(
              `  ${mapping.skipped ? 'skipped' : 'mapped '} ${mapping.from} -> ${mapping.to}`,
            )
          }
          if (!res.dryRun) getLogger().log(`  Changed: ${res.changed}`)
        },
      })
    })
}
