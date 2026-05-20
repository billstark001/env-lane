#!/usr/bin/env node
import { Command } from 'commander';
import {
  checkDotenvSelector,
  listEnvFiles,
  listWorkspacePackages,
  redactValue,
  resolveInjectedEnv,
  resolveTargetPackage,
  runWithInjectedEnv
} from '@env-lane/core';
import { decryptEnvFiles, encryptEnvFiles, sortEnvFile, sortEnvFilesFromConfig } from '@env-lane/vault';

const program = new Command();
program.name('env-lane').description('Workspace-aware dotenv injection and development vault tooling.').version('0.1.0');

function addCommonOptions(command: Command): Command {
  return command
    .option('-c, --config <file>', 'env-lane config file')
    .option('-b, --build <name>', 'build selector value')
    .option('--cwd <dir>', 'working directory');
}

program.command('packages')
  .description('List discovered workspace packages. Falls back to root in single-package projects.')
  .option('-c, --config <file>', 'env-lane config file')
  .option('--cwd <dir>', 'working directory')
  .option('--format <format>', 'json or text', 'text')
  .action(async (opts) => {
    const packages = await listWorkspacePackages({ cwd: opts.cwd, configFile: opts.config });
    if (opts.format === 'json') console.log(JSON.stringify(packages, null, 2));
    else for (const pkg of packages) console.log(`${pkg.name ?? '<unnamed>'}\t${pkg.relativeDir}\t${pkg.aliases.join(',')}`);
  });

addCommonOptions(program.command('resolve-target <target>'))
  .description('Resolve a target alias/name/path to a package.')
  .option('--format <format>', 'json or text', 'json')
  .action(async (target, opts) => {
    const resolved = await resolveTargetPackage(target, { cwd: opts.cwd, configFile: opts.config });
    console.log(opts.format === 'json' ? JSON.stringify(resolved, null, 2) : `${resolved.name ?? '<unnamed>'} ${resolved.dir}`);
  });

addCommonOptions(program.command('files [target]'))
  .alias('env-files')
  .description('List dotenv files in injection order.')
  .option('--require-override', 'fail if selected override file is missing')
  .option('--format <format>', 'json or text', 'text')
  .action(async (target, opts) => {
    const files = await listEnvFiles({ cwd: opts.cwd, configFile: opts.config, target, build: opts.build, requireOverride: opts.requireOverride });
    if (opts.format === 'json') console.log(JSON.stringify(files, null, 2));
    else for (const file of files) console.log(`${file.exists ? 'loaded ' : 'missing'} ${file.kind.padEnd(8)} ${file.relativePath}`);
  });

addCommonOptions(program.command('print <target>'))
  .alias('env-json')
  .description('Print final injected environment for a target.')
  .option('--format <format>', 'dotenv or json', 'dotenv')
  .option('--show-secrets', 'print secret-like values without redaction')
  .option('--no-process-env', 'do not merge process.env')
  .action(async (target, opts) => {
    const resolved = await resolveInjectedEnv({ cwd: opts.cwd, configFile: opts.config, target, build: opts.build, includeProcessEnv: opts.processEnv });
    if (opts.format === 'json') {
      const payload = Object.fromEntries(Object.keys(resolved.values).sort().map(key => [key, {
        value: redactValue(key, resolved.values[key], opts.showSecrets),
        source: resolved.sources[key]
      }]));
      console.log(JSON.stringify(payload, null, 2));
    } else {
      for (const key of Object.keys(resolved.values).sort()) console.log(`${key}=${redactValue(key, resolved.values[key], opts.showSecrets)}`);
    }
  });

addCommonOptions(program.command('run <target>')
  .argument('<command...>', 'command and arguments to run')
  .allowUnknownOption(true)
  .passThroughOptions())
  .description('Run a command with injected dotenv environment.')
  .option('--run-cwd <target|root|path>', 'command working directory', 'target')
  .option('--quiet', 'suppress run summary')
  .action(async (target, command, opts) => {
    const code = await runWithInjectedEnv({ cwd: opts.cwd, configFile: opts.config, target, build: opts.build, command, runCwd: opts.runCwd, quiet: opts.quiet });
    process.exit(code);
  });

addCommonOptions(program.command('check'))
  .description('Check that the selector key is not stored in dotenv files.')
  .action(async (opts) => {
    const result = await checkDotenvSelector({ cwd: opts.cwd, configFile: opts.config });
    if (!result.ok) {
      console.error(`${result.selectorKey} must not be stored in dotenv files:\n${result.violations.map(v => `  ${v.relativeFile}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`[env-lane] OK: ${result.selectorKey} is absent from dotenv files.`);
  });

const vault = program.command('vault').description('Unsafe development vault helpers. Not for production secret management.');
vault.command('encrypt <config> <keyFile>')
  .option('--disable-unsafe-warning', 'disable vault warning for this run')
  .action(async (config, keyFile, opts) => console.log(JSON.stringify(await encryptEnvFiles(config, keyFile, opts), null, 2)));
vault.command('decrypt <config> <keyFile>')
  .option('--dry-run', 'show planned restore without writing files')
  .option('--disable-unsafe-warning', 'disable vault warning for this run')
  .action(async (config, keyFile, opts) => console.log(JSON.stringify(await decryptEnvFiles(config, keyFile, opts), null, 2)));

program.command('sort-file <envFile> <templateFile>')
  .description('Sort one env file using a template env file.')
  .action(async (envFile, templateFile) => console.log(JSON.stringify(await sortEnvFile(envFile, templateFile), null, 2)));
program.command('sort <config> [key] [envSuffix]')
  .description('Sort env files using vault config sort section.')
  .action(async (config, key = 'all', envSuffix = 'all') => console.log(JSON.stringify(await sortEnvFilesFromConfig(config, key, envSuffix), null, 2)));

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
