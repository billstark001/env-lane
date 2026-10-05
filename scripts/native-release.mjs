import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const root = path.resolve(import.meta.dirname, '..')
const nativeManifestPath = path.join(root, 'packages/native/package.json')
const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, 'utf8'))
assert.deepEqual(new Set(nativeManifest.napi.targets), new Set(Object.keys(NATIVE_TARGETS)))
const artifactRoot = path.join(root, 'native-artifacts')
const [mode, target] = process.argv.slice(2)

if (mode === 'stage') {
  assert.ok(Object.hasOwn(NATIVE_TARGETS, target), `Unknown native target: ${target}`)
  const suffix = NATIVE_TARGETS[target]
  const sourceAddon = path.join(root, 'packages/native', `env-lane-native.${suffix}.node`)
  const binaryName = target.includes('windows') ? 'env-lane.exe' : 'env-lane'
  const sourceBinary = path.join(root, 'target', target, 'release', binaryName)
  const pluginName = target.includes('windows')
    ? 'env-lane-plugin-vault.exe'
    : 'env-lane-plugin-vault'
  const sourcePlugin = path.join(root, 'target', target, 'release', pluginName)
  assert.ok(existsSync(sourceAddon), `Missing Node addon: ${sourceAddon}`)
  assert.ok(existsSync(sourceBinary), `Missing CLI binary: ${sourceBinary}`)
  assert.ok(existsSync(sourcePlugin), `Missing Vault plugin binary: ${sourcePlugin}`)
  const destination = path.join(artifactRoot, `native-${suffix}`)
  mkdirSync(destination, { recursive: true })
  copyFileSync(sourceAddon, path.join(destination, path.basename(sourceAddon)))
  copyFileSync(sourceBinary, path.join(destination, binaryName))
  copyFileSync(sourcePlugin, path.join(destination, pluginName))
  process.stdout.write(`${destination}\n`)
} else if (mode === 'prepare') {
  const optionalDependencies = {}
  const vaultOptionalDependencies = {}
  for (const [triple, suffix] of Object.entries(NATIVE_TARGETS)) {
    const source = path.join(artifactRoot, `native-${suffix}`)
    const packageDir = path.join(root, 'packages/native/npm', suffix)
    const packageManifestPath = path.join(packageDir, 'package.json')
    const addonName = `env-lane-native.${suffix}.node`
    const binaryName = triple.includes('windows') ? 'env-lane.exe' : 'env-lane'
    const pluginName = triple.includes('windows')
      ? 'env-lane-plugin-vault.exe'
      : 'env-lane-plugin-vault'
    assert.ok(existsSync(path.join(source, addonName)), `Missing staged addon for ${suffix}`)
    assert.ok(existsSync(path.join(source, binaryName)), `Missing staged CLI for ${suffix}`)
    assert.ok(
      existsSync(path.join(packageDir, addonName)),
      `napi artifacts did not place ${suffix}`,
    )
    const platform = JSON.parse(readFileSync(packageManifestPath, 'utf8'))
    assert.equal(platform.name, `@env-lane/native-${suffix}`)
    assert.equal(platform.version, nativeManifest.version)
    assert.deepEqual(platform.files, [addonName])
    copyFileSync(path.join(source, binaryName), path.join(packageDir, binaryName))
    if (binaryName === 'env-lane') chmodSync(path.join(packageDir, binaryName), 0o755)
    platform.files.push(binaryName)
    writeFileSync(packageManifestPath, `${JSON.stringify(platform, null, 2)}\n`)
    optionalDependencies[platform.name] = nativeManifest.version
    const vaultPackageDir = path.join(root, 'packages/vault/npm', suffix)
    const vaultPackageManifestPath = path.join(vaultPackageDir, 'package.json')
    const vaultPlatform = JSON.parse(readFileSync(vaultPackageManifestPath, 'utf8'))
    assert.equal(vaultPlatform.name, `@env-lane/vault-native-${suffix}`)
    assert.equal(vaultPlatform.version, nativeManifest.version)
    assert.deepEqual(vaultPlatform.files, [pluginName])
    copyFileSync(path.join(source, pluginName), path.join(vaultPackageDir, pluginName))
    if (pluginName === 'env-lane-plugin-vault')
      chmodSync(path.join(vaultPackageDir, pluginName), 0o755)
    vaultOptionalDependencies[vaultPlatform.name] = nativeManifest.version
  }
  nativeManifest.optionalDependencies = optionalDependencies
  writeFileSync(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`)
  const vaultManifestPath = path.join(root, 'packages/vault/package.json')
  const vaultManifest = JSON.parse(readFileSync(vaultManifestPath, 'utf8'))
  vaultManifest.optionalDependencies = vaultOptionalDependencies
  writeFileSync(vaultManifestPath, `${JSON.stringify(vaultManifest, null, 2)}\n`)
  process.stdout.write(
    `Prepared ${Object.keys(NATIVE_TARGETS).length} platform packages and the root optional dependency manifest.\n`,
  )
} else {
  throw new Error('Usage: node scripts/native-release.mjs stage <target> | prepare')
}
