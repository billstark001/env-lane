#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import native from '@env-lane/native'
import binary from '@env-lane/native/bin.cjs'
import { compileConfig, locateConfig } from './cache.mjs'
import { inspectRunnerArguments } from './runner-arguments.mjs'

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  try {
    const args = inspectRunnerArguments(rest)
    const cwd = path.resolve(args.cwd ?? process.cwd())
    const configFile = args.configFile
    const environment = { ...process.env }
    const activeCaches = {}
    const main = await locateConfig({ cwd, configFile })
    if (main.executable) {
      const compiled = await compileConfig({ cwd, configFile })
      if (!compiled.cacheable) activeCaches.main = compiled.file
    }
    const previousCaches = process.env.ENV_LANE_CONFIG_CACHES
    process.env.ENV_LANE_CONFIG_CACHES = JSON.stringify(activeCaches)
    let registrations
    try {
      const response = JSON.parse(
        native.invoke('core.registeredPlugins', JSON.stringify({ cwd, configFile })),
      )
      if (!response.ok) throw new Error(response.error?.message ?? 'Config validation failed')
      registrations = response.result.value
    } finally {
      if (previousCaches === undefined) delete process.env.ENV_LANE_CONFIG_CACHES
      else process.env.ENV_LANE_CONFIG_CACHES = previousCaches
    }
    for (const plugin of registrations.plugins) {
      const pluginConfig = path.resolve(registrations.projectRoot, plugin.configFile)
      const located = await locateConfig({
        kind: plugin.name,
        cwd: registrations.projectRoot,
        configFile: pluginConfig,
      })
      if (located.executable) {
        const compiled = await compileConfig({
          kind: plugin.name,
          cwd: registrations.projectRoot,
          configFile: pluginConfig,
          packageName: plugin.packageName,
        })
        if (!compiled.cacheable) activeCaches[plugin.name] = compiled.file
      }
    }
    environment.ENV_LANE_CONFIG_CACHES = JSON.stringify(activeCaches)
    const result = spawnSync(binary.resolveBinary(), rest, { stdio: 'inherit', env: environment })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else if (command !== 'compile') {
  process.stderr.write(
    'Usage: env-lane-config compile [--kind main|PLUGIN_FIELD] [--cwd dir] [--config file] [--package-name npm-package] | run [env-lane arguments]\n',
  )
  process.exitCode = 1
} else {
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!value || !['--kind', '--cwd', '--config', '--package-name'].includes(flag)) {
      process.stderr.write(`Invalid option: ${flag}\n`)
      process.exit(1)
    }
    options[
      {
        '--kind': 'kind',
        '--cwd': 'cwd',
        '--config': 'configFile',
        '--package-name': 'packageName',
      }[flag]
    ] = value
  }
  try {
    const result = await compileConfig(options)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
