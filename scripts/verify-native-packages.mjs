import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const fixtureRoot = process.argv[2] === '--root' ? process.argv[3] : undefined
if (process.argv[2] === '--root' && !fixtureRoot) throw new Error('--root requires a directory')
const root = fixtureRoot ? path.resolve(fixtureRoot) : path.resolve(import.meta.dirname, '..')
const nativeDir = path.join(root, 'packages/native')
const manifest = JSON.parse(readFileSync(path.join(nativeDir, 'package.json'), 'utf8'))
const vaultDir = path.join(root, 'packages/vault')
const vaultManifest = JSON.parse(readFileSync(path.join(vaultDir, 'package.json'), 'utf8'))
assert.deepEqual(new Set(manifest.napi.targets), new Set(Object.keys(NATIVE_TARGETS)))
assert.equal(
  Object.keys(manifest.optionalDependencies ?? {}).length,
  Object.keys(NATIVE_TARGETS).length,
)
assert.equal(
  Object.keys(vaultManifest.optionalDependencies ?? {}).length,
  Object.keys(NATIVE_TARGETS).length,
)
assert.deepEqual(
  new Set(Object.keys(vaultManifest.envLanePlugin.entry.platforms)),
  new Set(Object.values(NATIVE_TARGETS)),
)
for (const [triple, suffix] of Object.entries(NATIVE_TARGETS)) {
  const [expectedOs, expectedCpu, abi] = suffix.split('-')
  const expectedLibc = expectedOs === 'linux' ? [abi === 'gnu' ? 'glibc' : 'musl'] : undefined
  const directory = path.join(nativeDir, 'npm', suffix)
  const platform = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const addon = `env-lane-native.${suffix}.node`
  const binary = triple.includes('windows') ? 'env-lane.exe' : 'env-lane'
  assert.equal(platform.name, `@env-lane/native-${suffix}`)
  assert.equal(platform.version, manifest.version)
  assert.deepEqual(platform.os, [expectedOs])
  assert.deepEqual(platform.cpu, [expectedCpu])
  assert.deepEqual(platform.libc, expectedLibc)
  assert.equal(manifest.optionalDependencies[platform.name], manifest.version)
  assert.deepEqual(new Set(platform.files), new Set([addon, binary]))
  for (const file of [addon, binary]) {
    const full = path.join(directory, file)
    assert.ok(existsSync(full) && statSync(full).size > 100_000, `Missing ${full}`)
  }
  const packed = spawnSync('npm', ['pack', directory, '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  assert.equal(packed.status, 0, packed.stderr)
  const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path))
  assert.ok(
    files.has(addon) && files.has(binary) && files.has('README.md'),
    `Platform tarball missing files for ${suffix}`,
  )
  const pluginName = triple.includes('windows')
    ? 'env-lane-plugin-vault.exe'
    : 'env-lane-plugin-vault'
  const vaultPlatformDir = path.join(vaultDir, 'npm', suffix)
  const vaultPlatform = JSON.parse(
    readFileSync(path.join(vaultPlatformDir, 'package.json'), 'utf8'),
  )
  assert.equal(vaultPlatform.name, `@env-lane/vault-native-${suffix}`)
  assert.equal(vaultPlatform.version, vaultManifest.version)
  assert.deepEqual(vaultPlatform.os, [expectedOs])
  assert.deepEqual(vaultPlatform.cpu, [expectedCpu])
  assert.deepEqual(vaultPlatform.libc, expectedLibc)
  assert.equal(vaultManifest.optionalDependencies[vaultPlatform.name], vaultManifest.version)
  assert.deepEqual(vaultManifest.envLanePlugin.entry.platforms[suffix], {
    package: vaultPlatform.name,
    path: `./${pluginName}`,
  })
  assert.deepEqual(vaultPlatform.files, [pluginName])
  const vaultBinary = path.join(vaultPlatformDir, pluginName)
  assert.ok(
    existsSync(vaultBinary) && statSync(vaultBinary).size > 100_000,
    `Missing ${vaultBinary}`,
  )
  const vaultPacked = spawnSync(
    'npm',
    ['pack', vaultPlatformDir, '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  )
  assert.equal(vaultPacked.status, 0, vaultPacked.stderr)
  const vaultFiles = new Set(JSON.parse(vaultPacked.stdout)[0].files.map((file) => file.path))
  assert.ok(vaultFiles.has(pluginName) && vaultFiles.has('README.md'))
}
process.stdout.write(
  `Verified ${Object.keys(NATIVE_TARGETS).length} native and Vault platform packages.\n`,
)
