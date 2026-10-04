#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import native from '@env-lane/native/bin.cjs'
import { compileConfig, locateConfig } from './cache.mjs'
import { inspectRunnerArguments } from './runner-arguments.mjs'

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  try {
    const args = inspectRunnerArguments(rest)
    const cwd = path.resolve(args.cwd ?? process.cwd())
    const configFile = args.configFile
    const environment = { ...process.env }
    const main = await locateConfig({ cwd, configFile })
    let mainConfig
    if (main.executable) {
      const result = await compileConfig({ cwd, configFile })
      if (!result.cacheable) environment.ENV_LANE_MAIN_CONFIG_CACHE = result.file
      mainConfig = JSON.parse(readFileSync(result.file, 'utf8')).config
    }
    if (args.operation === 'vault') {
      const vaultConfig = args.vaultConfig ?? mainConfig?.vault?.configFile
      const vault = await locateConfig({ kind: 'vault', cwd, configFile: vaultConfig })
      if (vault.executable) {
        const result = await compileConfig({ kind: 'vault', cwd, configFile: vaultConfig })
        if (!result.cacheable) environment.ENV_LANE_VAULT_CONFIG_CACHE = result.file
      }
    }
    const result = spawnSync(native.resolveBinary(), rest, { stdio: 'inherit', env: environment })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else if (command !== 'compile') {
  process.stderr.write(
    'Usage: env-lane-config compile [--kind main|vault] [--cwd dir] [--config file] | run [env-lane arguments]\n',
  )
  process.exitCode = 1
} else {
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!value || !['--kind', '--cwd', '--config'].includes(flag)) {
      process.stderr.write(`Invalid option: ${flag}\n`)
      process.exit(1)
    }
    options[{ '--kind': 'kind', '--cwd': 'cwd', '--config': 'configFile' }[flag]] = value
  }
  try {
    const result = await compileConfig(options)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
