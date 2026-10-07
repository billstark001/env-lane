import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_TARGETS } from './native-targets.mjs'

export const workspace = path.resolve(import.meta.dirname, '..')
export const packageDirectories = {
  '@env-lane/native': 'packages/native',
  '@env-lane/plugin-sdk': 'packages/plugin-sdk',
  '@env-lane/config-compat': 'packages/config-compat',
  '@env-lane/core': 'packages/core',
  '@env-lane/vault': 'packages/vault',
  'env-lane': 'packages/cli',
}

export function readJson(root, file) {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8'))
}

export function releaseTag(args = process.argv.slice(2)) {
  const index = args.indexOf('--tag')
  const tag = index === -1 ? process.env.GITHUB_REF_NAME : args[index + 1]
  tagIdentity(tag ?? '')
  return tag
}

function tagIdentity(tag) {
  const matched = /^(?:(native|core|vault|cli|config-compat|plugin-sdk)-)?v(\d+\.\d+\.\d+)$/.exec(
    tag,
  )
  assert.ok(matched, 'Pass a stable tag, such as v0.5.1 or core-v0.5.2')
  return { scope: matched[1], version: matched[2] }
}

export function loadReleasePlan(root, tag) {
  const identity = tagIdentity(tag)
  const source = readJson(root, `releases/${tag}.json`)
  assert.deepEqual(Object.keys(source).sort(), ['packages', 'standalone'])
  assert.equal(typeof source.standalone, 'boolean')
  assert.ok(source.packages && typeof source.packages === 'object')
  assert.ok(!Array.isArray(source.packages) && Object.keys(source.packages).length > 0)
  const selected = new Set(Object.keys(source.packages))
  for (const name of selected) assert.ok(Object.hasOwn(packageDirectories, name), `Unknown ${name}`)
  const packages = Object.entries(packageDirectories)
    .filter(([name]) => selected.has(name))
    .map(([name, directory]) => {
      const manifest = readJson(root, `${directory}/package.json`)
      assert.equal(manifest.name, name)
      assert.notEqual(manifest.private, true, `${name} must be publishable`)
      assert.match(source.packages[name], /^\d+\.\d+\.\d+$/, `${name} needs a stable version`)
      assert.equal(manifest.version, source.packages[name], `${name} release version`)
      return { name, version: manifest.version, directory }
    })
  const native = selected.has('@env-lane/native')
  const vault = selected.has('@env-lane/vault')
  assert.ok(!source.standalone || native, 'Standalone releases require @env-lane/native')
  const batchVersion = identity.version
  if (identity.scope) {
    const scopeName = identity.scope === 'cli' ? 'env-lane' : `@env-lane/${identity.scope}`
    assert.equal(source.packages[scopeName], batchVersion, `${scopeName} tag selection`)
  }
  assert.ok(
    packages.some((item) => item.version === batchVersion),
    'Batch tag needs a selected version',
  )
  for (const item of packages) {
    assert.ok(
      item.version.localeCompare(batchVersion, 'en', { numeric: true }) <= 0,
      `${item.name} exceeds the batch version`,
    )
  }
  return { tag, packages, native, vault, standalone: source.standalone }
}

export function publishEntries(plan) {
  const entries = []
  for (const item of plan.packages) {
    const prefix = item.name === '@env-lane/native' ? 'native' : 'vault-native'
    if (item.name === '@env-lane/native' || item.name === '@env-lane/vault') {
      for (const suffix of Object.values(NATIVE_TARGETS).sort()) {
        entries.push({
          name: `@env-lane/${prefix}-${suffix}`,
          version: item.version,
          directory: `${item.directory}/npm/${suffix}`,
          platform: true,
        })
      }
    }
    entries.push({ ...item, platform: false })
  }
  return entries
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = loadReleasePlan(workspace, releaseTag())
  process.stdout.write(`${JSON.stringify({ ...plan, publish: publishEntries(plan) }, null, 2)}\n`)
}
