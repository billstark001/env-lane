import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [runtimePath, fixtureRoot, operation, rawInput = '{}'] = process.argv.slice(2)
const input = JSON.parse(rawInput)
const core = await import(
  pathToFileURL(path.join(runtimePath, 'node_modules/@env-lane/core/dist/index.js'))
)
const envDocument = await import(
  pathToFileURL(path.join(runtimePath, 'node_modules/@env-lane/core/dist/env-document.js'))
)

function absolute(value) {
  return value === undefined ? undefined : path.resolve(fixtureRoot, value)
}

function coreOptions(value = {}) {
  return {
    ...value,
    cwd: absolute(value.cwd ?? '.'),
    configFile: value.configFile ? absolute(value.configFile) : undefined,
  }
}

function jsonValue(value) {
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([key, item]) => [key, jsonValue(item)]))
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  }
  return value
}

async function execute() {
  switch (operation) {
    case 'core.load-config':
      return core.loadEnvLaneConfig(coreOptions(input))
    case 'core.packages':
      return core.listWorkspacePackages(coreOptions(input))
    case 'core.resolve-target':
      return core.resolveTargetPackage(input.target, coreOptions(input))
    case 'core.files':
      return core.listEnvFiles(coreOptions(input))
    case 'core.resolve':
      return core.resolveInjectedEnv(coreOptions({ ...input, includeProcessEnv: false }))
    case 'core.selector-check':
      return core.checkDotenvSelector(coreOptions(input))
    case 'core.policy-check':
      return core.runEnvCheck(input.name, coreOptions(input))
    case 'core.sync':
      return core.runEnvSync(input.name, coreOptions(input))
    case 'core.sort-file':
      return core.sortEnvFile(absolute(input.file), absolute(input.template), {
        cwd: fixtureRoot,
        check: input.check,
        preserveBOM: input.preserveBOM,
        eol: input.eol,
      })
    case 'env.parse': {
      const parsed = envDocument.parseEnvDocument(input.content)
      return {
        ...parsed,
        currentMap: jsonValue(parsed.currentMap),
        occurrencesMap: jsonValue(parsed.occurrencesMap),
      }
    }
    case 'env.format':
      return { formatted: envDocument.formatEnvValue(input.value) }
    case 'env.patch':
      return envDocument.applyEnvDocumentPatches(absolute(input.file), input.patches, input.options)
    default:
      break
  }

  const vault = await import(
    pathToFileURL(path.join(runtimePath, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  switch (operation) {
    case 'vault.load-config':
      return vault.loadVaultConfig(input.configFile && absolute(input.configFile), {
        cwd: fixtureRoot,
        vaultConfigFile: input.vaultConfigFile && absolute(input.vaultConfigFile),
      })
    case 'vault.encrypt':
      return vault.encryptEnvFiles(
        input.configFile && absolute(input.configFile),
        absolute(input.keyFile),
        { ...input.options, cwd: fixtureRoot },
      )
    case 'vault.plan':
      return vault.buildRestorePlan(
        input.configFile && absolute(input.configFile),
        absolute(input.keyFile),
        { ...input.options, cwd: fixtureRoot },
      )
    case 'vault.decrypt':
      return vault.decryptEnvFiles(
        input.configFile && absolute(input.configFile),
        absolute(input.keyFile),
        { ...input.options, cwd: fixtureRoot },
      )
    default:
      throw new Error(`Unknown compatibility API operation: ${operation}`)
  }
}

try {
  const value = await execute()
  process.stdout.write(`${JSON.stringify(jsonValue(value), null, 2)}\n`)
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        name: error instanceof Error ? error.name : 'Error',
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
        details:
          error && typeof error === 'object' && 'details' in error ? error.details : undefined,
      },
      null,
      2,
    )}\n`,
  )
  process.exitCode = 1
}
