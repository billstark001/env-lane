import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'))
const version = readJson('package.json').version
for (const name of [
  'core',
  'vault',
  'cli',
  'native',
  'config-compat',
  'plugin-sdk',
  'compat-test',
]) {
  assert.equal(
    readJson(`packages/${name}/package.json`).version,
    version,
    `${name} package version`,
  )
}
const cargo = readFileSync(path.join(root, 'Cargo.toml'), 'utf8')
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], version, 'Cargo workspace version')

const protocol = readJson('crates/env-lane-plugin-api/schema/package.schema.json').properties
  .envLanePlugin.properties.protocolVersion.const
const source = readFileSync(path.join(root, 'crates/env-lane-plugin-api/src/lib.rs'), 'utf8')
const sdk = readFileSync(path.join(root, 'packages/plugin-sdk/src/index.ts'), 'utf8')
assert.equal(Number(source.match(/pub const PROTOCOL_VERSION: u32 = (\d+);/)?.[1]), protocol)
assert.equal(Number(sdk.match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1]), protocol)
assert.equal(readJson('packages/vault/package.json').envLanePlugin.protocolVersion, protocol)

process.stdout.write(`Workspace metadata verified for ${version}.\n`)
