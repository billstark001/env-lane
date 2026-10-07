import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { packageDirectories, readJson, workspace } from './release-plan.mjs'

const baseline = readJson(workspace, 'package.json').version
const manifests = new Map(
  Object.entries(packageDirectories).map(([name, directory]) => [
    name,
    readJson(workspace, `${directory}/package.json`),
  ]),
)
manifests.set('@env-lane/compat-test', readJson(workspace, 'packages/compat-test/package.json'))

function versionParts(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  return version.split('.').map(Number)
}

function compatibleLine(version, expected, label) {
  const actual = versionParts(version)
  const line = versionParts(expected)
  assert.equal(actual[0], line[0], `${label} major version`)
  if (line[0] === 0) assert.equal(actual[1], line[1], `${label} pre-1.0 minor version`)
}

for (const [name, manifest] of manifests) {
  compatibleLine(manifest.version, baseline, name)
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
      if (!manifests.has(dependency)) continue
      assert.match(range, /^workspace:\^\d+\.\d+\.\d+$/, `${name} -> ${dependency} range`)
      const minimum = range.slice('workspace:^'.length)
      const available = manifests.get(dependency).version
      compatibleLine(available, minimum, `${name} -> ${dependency}`)
      assert.ok(
        available.localeCompare(minimum, 'en', { numeric: true }) >= 0,
        `${name} requires ${dependency} >= ${minimum}, found ${available}`,
      )
    }
  }
}
const cargo = JSON.parse(
  execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], {
    cwd: workspace,
    encoding: 'utf8',
  }),
)
const members = new Set(cargo.workspace_members)
for (const item of cargo.packages.filter((item) => members.has(item.id))) {
  compatibleLine(item.version, baseline, item.name)
}
for (const [rust, npm] of [
  ['env-lane-cli', 'env-lane'],
  ['env-lane-plugin-vault', '@env-lane/vault'],
]) {
  assert.equal(
    cargo.packages.find((item) => item.name === rust)?.version,
    manifests.get(npm).version,
  )
}

const protocol = readJson(workspace, 'crates/env-lane-plugin-api/schema/package.schema.json')
  .properties.envLanePlugin.properties.protocolVersion.const
const source = readFileSync(`${workspace}/crates/env-lane-plugin-api/src/lib.rs`, 'utf8')
const sdk = readFileSync(`${workspace}/packages/plugin-sdk/src/index.ts`, 'utf8')
assert.equal(Number(source.match(/pub const PROTOCOL_VERSION: u32 = (\d+);/)?.[1]), protocol)
assert.equal(Number(sdk.match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1]), protocol)
assert.equal(manifests.get('@env-lane/vault').envLanePlugin.protocolVersion, protocol)

process.stdout.write(
  `Workspace release line and compatible dependency ranges verified (${baseline}).\n`,
)
