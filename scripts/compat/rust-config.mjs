import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { plainValue, runRustExample, withOracle, workspace } from './rust-support.mjs'

const coreFields = ['selector', 'workspace', 'dotenv', 'output', 'sort', 'checks', 'sync']
function coreConfig(config) {
  return Object.fromEntries(coreFields.map((field) => [field, config[field]]))
}

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js'))
  )
  const requests = []
  const expected = []
  for (const topology of ['moment-project', 'moment-landing']) {
    const root = path.join(temporary, topology)
    cpSync(path.join(workspace, 'compat/fixtures/topologies', topology), root, { recursive: true })
    const options = { cwd: root, configFile: path.join(root, 'env-lane.config.json') }
    requests.push(options)
    expected.push(plainValue(await legacy.loadEnvLaneConfig(options)))
    const packages = await legacy.listWorkspacePackages(options)
    const config = await legacy.loadEnvLaneConfig(options)
    const selector = config.selector.envKey
    const processEnv =
      process.env[selector] === undefined ? {} : { [selector]: process.env[selector] }
    for (const pkg of packages) {
      for (const build of config.selector.builds) {
        const resolveOptions = {
          ...options,
          target: pkg.relativeDir,
          build,
          includeProcessEnv: false,
        }
        for (const [operation, execute] of [
          ['files', legacy.listEnvFiles],
          ['resolve', legacy.resolveInjectedEnv],
        ]) {
          requests.push({ ...resolveOptions, operation, processEnv })
          expected.push(plainValue(await execute(resolveOptions)))
        }
      }
    }

    requests.push({ ...options, operation: 'packages' })
    expected.push(plainValue(packages))
    for (const target of [undefined, 'does-not-exist', ...packages.flatMap((pkg) => pkg.aliases)]) {
      requests.push({ ...options, operation: 'resolveTarget', target })
      try {
        expected.push(plainValue(await legacy.resolveTargetPackage(target, options)))
      } catch (error) {
        expected.push({ error: error.code, message: error.message })
      }
    }
  }
  const root = path.join(temporary, 'config-cases')
  mkdirSync(root)
  writeFileSync(path.join(root, 'package.json'), '{}')
  const configs = [
    {},
    { workspace: { packageGlobs: [] }, extension: { ignored: true } },
    { sort: { app: { baseDir: 'nested', create: false } } },
    {
      checks: {
        check: {
          sources: { a: { file: '.env' } },
          rules: [{ type: 'required', source: 'a', key: 'A' }],
        },
      },
    },
    {
      sync: {
        copy: {
          from: { file: '.env' },
          to: { target: 'web', variant: 'local' },
          mappings: [{ from: 'A', to: 'B', transform: 'trim' }],
        },
      },
    },
  ]
  for (const [index, config] of configs.entries()) {
    const configFile = path.join(root, `config-${index}.json`)
    writeFileSync(configFile, JSON.stringify(config))
    const options = { cwd: root, configFile }
    requests.push(options)
    expected.push(plainValue(await legacy.loadEnvLaneConfig(options)))
  }
  const actual = runRustExample('config-protocol', requests)
  for (const [index, response] of actual.entries()) {
    const request = requests[index]
    if (request.configFile.endsWith('config-1.json')) {
      // 0.4.2 ignored unknown root fields; 0.5 treats them as plugin
      // registrations and rejects one without the required shape.
      assert.equal(response.error, 'CONFIG_LOAD_FAILED')
      continue
    }
    assert.deepEqual(
      request.operation ? response : coreConfig(response),
      request.operation ? expected[index] : coreConfig(expected[index]),
      `Config case ${index}: ${JSON.stringify(request)}`,
    )
  }
  process.stdout.write(
    `Rust config/workspace/resolve differential: ${actual.length} stable cases passed; plugin registration follows 0.5.0.\n`,
  )
})
