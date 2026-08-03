import {
  checkDotenvSelector,
  EnvLaneError,
  emitDiagnostic,
  formatEnvValue,
  listEnvFiles,
  listWorkspacePackages,
  redactValue,
  resolveInjectedEnv,
  resolveTargetPackage,
  runEnvCheck,
  runEnvSync,
  runWithInjectedEnv,
} from '@env-lane/core'
import { Command, type Option, type ParseOptionsResult } from 'commander'
import type { CliContext } from '../runtime/context.js'

function optionConsumesNextArgument(option: Option): boolean {
  return option.required || option.optional
}

function matchingRunOption(options: readonly Option[], argument: string): Option | undefined {
  const exactMatch = options.find((option) => argument === option.short || argument === option.long)
  if (exactMatch) return exactMatch

  if (argument.startsWith('--')) {
    const equalsIndex = argument.indexOf('=')
    if (equalsIndex !== -1) {
      const flag = argument.slice(0, equalsIndex)
      return options.find((option) => option.long === flag)
    }
    return undefined
  }

  if (argument.startsWith('-') && argument.length > 2) {
    return options.find(
      (option) => option.short === argument.slice(0, 2) && optionConsumesNextArgument(option),
    )
  }
  return undefined
}

/**
 * Move env-lane options between the target and child command ahead of the target.
 * The child starts at `--`, or at the first non-option after the target when the
 * explicit boundary is omitted. Commander then preserves every child argument.
 */
export function normalizeRunArguments(
  args: readonly string[],
  options: readonly Option[],
): string[] {
  const boundaryIndex = args.indexOf('--')
  const cliEndIndex = boundaryIndex === -1 ? args.length : boundaryIndex
  const beforeTarget: string[] = []
  let targetIndex = -1

  for (let index = 0; index < cliEndIndex; index += 1) {
    const argument = args[index]
    const option = matchingRunOption(options, argument)
    if (option) {
      beforeTarget.push(argument)
      const hasInlineValue = argument.startsWith('--') && argument.includes('=')
      const hasAttachedShortValue =
        Boolean(option.short) &&
        argument.startsWith(option.short as string) &&
        argument !== option.short
      if (optionConsumesNextArgument(option) && !hasInlineValue && !hasAttachedShortValue) {
        const value = args[index + 1]
        if (value !== undefined) {
          beforeTarget.push(value)
          index += 1
        }
      }
      continue
    }
    if (argument.startsWith('-')) {
      beforeTarget.push(argument)
      continue
    }
    targetIndex = index
    break
  }

  if (targetIndex === -1) return [...args]

  const target = args[targetIndex]
  if (boundaryIndex !== -1) {
    return [
      ...beforeTarget,
      ...args.slice(targetIndex + 1, boundaryIndex),
      target,
      ...args.slice(boundaryIndex),
    ]
  }

  const afterTargetOptions: string[] = []
  let childIndex = targetIndex + 1
  while (childIndex < args.length) {
    const argument = args[childIndex]
    const option = matchingRunOption(options, argument)
    if (!option) {
      if (argument.startsWith('-')) {
        afterTargetOptions.push(argument)
        childIndex += 1
        continue
      }
      break
    }
    afterTargetOptions.push(argument)
    childIndex += 1

    const hasInlineValue = argument.startsWith('--') && argument.includes('=')
    const hasAttachedShortValue =
      Boolean(option.short) &&
      argument.startsWith(option.short as string) &&
      argument !== option.short
    if (optionConsumesNextArgument(option) && !hasInlineValue && !hasAttachedShortValue) {
      const value = args[childIndex]
      if (value !== undefined) {
        afterTargetOptions.push(value)
        childIndex += 1
      }
    }
  }

  return [...beforeTarget, ...afterTargetOptions, target, ...args.slice(childIndex)]
}

class RunCommand extends Command {
  override parseOptions(args: string[]): ParseOptionsResult {
    return super.parseOptions(normalizeRunArguments(args, this.options))
  }
}

function registerWorkspaceCommands(program: Command, ctx: CliContext): void {
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
          for (const pkg of pkgs)
            ctx.output(`${pkg.name ?? '<unnamed>'}\t${pkg.relativeDir}\t${pkg.aliases.join(',')}`)
        },
      })
    })
}

function registerResolveTargetCommand(program: Command, ctx: CliContext): void {
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
          ctx.output(`${res.name ?? '<unnamed>'} ${res.dir}`)
        },
      })
    })
}

function registerFilesCommand(program: Command, ctx: CliContext): void {
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
              ctx.output(`# ${entry.target.name ?? entry.target.relativeDir}`)
              for (const file of entry.files)
                ctx.output(
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
            ctx.output(
              `${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`,
            )
        },
      })
    })
}

function registerPrintCommand(program: Command, ctx: CliContext): void {
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
        dotenv: (res) => {
          for (const key of keys) {
            const value = redactValue(key, res.values[key], allOpts.showSecrets)
            ctx.output(`${key}=${formatEnvValue(value)}`)
          }
        },
        text: (res) => {
          for (const key of keys)
            ctx.output(`${key}=${redactValue(key, res.values[key], allOpts.showSecrets)}`)
        },
      })
    })
}

function registerRunCommand(program: Command, ctx: CliContext): void {
  const runCommand = new RunCommand('run')
  program.addCommand(runCommand)
  ctx
    .addCommonOptions(
      runCommand
        .argument('<target>', 'workspace target')
        .argument('<command...>', 'command and arguments to run')
        .passThroughOptions(),
    )
    .description('Run a command with injected dotenv environment.')
    .option('--run-cwd <target|root|path>', 'command working directory', 'target')
    .option('--quiet', 'suppress run summary')
    .action(async (target, command, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      if (format !== 'text') {
        throw new EnvLaneError(
          'UNSUPPORTED_OUTPUT_FORMAT',
          'The run command supports only text output because the child process owns stdout.',
        )
      }
      const normalizedCommand = command[0] === '--' ? command.slice(1) : command
      const resolved = !allOpts.quiet
        ? await resolveInjectedEnv({
            cwd: allOpts.cwd,
            configFile: allOpts.config,
            target,
            build: allOpts.build,
          })
        : undefined
      if (resolved) {
        const loaded = resolved.files
          .filter((file) => file.exists)
          .map((file) => file.relativePath)
          .join(', ')
        emitDiagnostic({
          code: 'RUN_SUMMARY',
          level: 'info',
          scope: 'core',
          message: `target=${resolved.target.name ?? resolved.target.relativeDir} build=${resolved.build} loaded=${loaded || '<none>'}`,
        })
      }
      const code = await runWithInjectedEnv({
        cwd: allOpts.cwd,
        configFile: allOpts.config,
        target,
        build: allOpts.build,
        command: normalizedCommand,
        runCwd: allOpts.runCwd,
        resolved,
      })
      process.exitCode = code
    })
}

function registerCheckCommand(program: Command, ctx: CliContext): void {
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
        throw new EnvLaneError(
          'INVALID_CHECK_SELECTION',
          'Use either --policy or --target, not both.',
        )
      }
      if (!allOpts.policy && !allOpts.target) {
        throw new EnvLaneError(
          'MISSING_CHECK_SELECTION',
          'Missing check selection. Use --policy <name> or --target <target>.',
        )
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
              ctx.output(`[${prefix}] ${finding.message}`)
            }
            ctx.output(
              `Summary: ${res.summary.ok} ok, ${res.summary.warnings} warnings, ${res.summary.errors} errors.`,
            )
          },
        })
        if (!result.ok) process.exitCode = 1
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
          ctx.output(JSON.stringify(result, null, 2))
        } else {
          if (result.violations.length) {
            emitDiagnostic({
              code: 'SELECTOR_IN_DOTENV',
              level: 'error',
              scope: 'core',
              message: `${result.selectorKey} must not be stored in dotenv files:\n${result.violations.map((v) => `  ${v.relativeFile}${v.line ? `:${v.line}` : ''}`).join('\n')}`,
            })
          }
          if (result.missingRequired.length) {
            emitDiagnostic({
              code: 'MISSING_REQUIRED_ENV_FILE',
              level: 'error',
              scope: 'core',
              message: `Missing required env file(s):\n${result.missingRequired.map((file) => `  ${file.target}: ${file.relativeFile}`).join('\n')}`,
            })
          }
        }
        process.exitCode = 1
        return
      }

      ctx.formatAndLog(result, {
        format,
        text: (res) => {
          ctx.output(`OK: ${res.selectorKey} is absent from dotenv files.`)
        },
      })
    })
}

function registerSyncCommand(program: Command, ctx: CliContext): void {
  ctx
    .addCommonOptions(program.command('sync <name>'))
    .description('Run a configured env value sync.')
    .option('--dry-run', 'show mapped values without writing files')
    .option('--show-secrets', 'include secret-like mapped values in JSON output')
    .action(async (name, opts) => {
      const allOpts = ctx.mergeOptions(opts)
      const format = await ctx.resolveOutputFormat(allOpts)
      if (format === 'dotenv') {
        throw new EnvLaneError(
          'UNSUPPORTED_OUTPUT_FORMAT',
          'The sync command does not support --format dotenv.',
        )
      }
      const result = await runEnvSync(name, {
        cwd: allOpts.cwd,
        configFile: allOpts.config,
        build: allOpts.build,
        dryRun: allOpts.dryRun,
      })
      ctx.formatAndLog(result, {
        format,
        json: (res) => ({
          ...res,
          mappings: res.mappings.map((mapping) => ({
            ...mapping,
            value: redactValue(mapping.to, mapping.value, allOpts.showSecrets),
          })),
        }),
        text: (res) => {
          ctx.output(`${res.dryRun ? 'Would sync' : 'Synced'} ${res.sync} -> ${res.targetFile}`)
          for (const mapping of res.mappings) {
            ctx.output(
              `  ${mapping.skipped ? 'skipped' : 'mapped '} ${mapping.from} -> ${mapping.to}`,
            )
          }
          if (!res.dryRun) ctx.output(`  Changed: ${res.changed}`)
        },
      })
    })
}

export function registerCoreCommands(program: Command, ctx: CliContext): void {
  registerWorkspaceCommands(program, ctx)
  registerResolveTargetCommand(program, ctx)
  registerFilesCommand(program, ctx)
  registerPrintCommand(program, ctx)
  registerRunCommand(program, ctx)
  registerCheckCommand(program, ctx)
  registerSyncCommand(program, ctx)
}
