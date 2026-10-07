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
import {
  nativePlatformManifest,
  platformReadme,
  vaultPlatformManifest,
} from './platform-packages.mjs'

const root = path.resolve(import.meta.dirname, '..')
const [mode, target, fixtureRoot] = process.argv.slice(2)
if (mode === 'prepare' && target === '--root' && !fixtureRoot) {
  throw new Error('prepare --root requires a directory')
}
const packageRoot = mode === 'prepare' && target === '--root' ? path.resolve(fixtureRoot) : root
const nativeManifestPath = path.join(packageRoot, 'packages/native/package.json')
const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, 'utf8'))
const vaultManifestPath = path.join(packageRoot, 'packages/vault/package.json')
const vaultManifest = JSON.parse(readFileSync(vaultManifestPath, 'utf8'))
assert.deepEqual(new Set(nativeManifest.napi.targets), new Set(Object.keys(NATIVE_TARGETS)))
const artifactRoot = path.join(packageRoot, 'native-artifacts')

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
    const packageDir = path.join(packageRoot, 'packages/native/npm', suffix)
    const addonName = `env-lane-native.${suffix}.node`
    const binaryName = triple.includes('windows') ? 'env-lane.exe' : 'env-lane'
    const pluginName = triple.includes('windows')
      ? 'env-lane-plugin-vault.exe'
      : 'env-lane-plugin-vault'
    assert.ok(existsSync(path.join(source, addonName)), `Missing staged addon for ${suffix}`)
    assert.ok(existsSync(path.join(source, binaryName)), `Missing staged CLI for ${suffix}`)
    assert.ok(existsSync(path.join(source, pluginName)), `Missing staged plugin for ${suffix}`)
    mkdirSync(packageDir, { recursive: true })
    const platform = nativePlatformManifest(
      suffix,
      nativeManifest.version,
      nativeManifest.description,
    )
    copyFileSync(path.join(source, addonName), path.join(packageDir, addonName))
    copyFileSync(path.join(source, binaryName), path.join(packageDir, binaryName))
    if (binaryName === 'env-lane') chmodSync(path.join(packageDir, binaryName), 0o755)
    writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(platform, null, 2)}\n`)
    writeFileSync(path.join(packageDir, 'README.md'), platformReadme(platform))
    optionalDependencies[platform.name] = nativeManifest.version
    const vaultPackageDir = path.join(packageRoot, 'packages/vault/npm', suffix)
    mkdirSync(vaultPackageDir, { recursive: true })
    const vaultPlatform = vaultPlatformManifest(suffix, vaultManifest.version)
    copyFileSync(path.join(source, pluginName), path.join(vaultPackageDir, pluginName))
    if (pluginName === 'env-lane-plugin-vault')
      chmodSync(path.join(vaultPackageDir, pluginName), 0o755)
    writeFileSync(
      path.join(vaultPackageDir, 'package.json'),
      `${JSON.stringify(vaultPlatform, null, 2)}\n`,
    )
    writeFileSync(path.join(vaultPackageDir, 'README.md'), platformReadme(vaultPlatform))
    vaultOptionalDependencies[vaultPlatform.name] = vaultManifest.version
  }
  nativeManifest.optionalDependencies = optionalDependencies
  writeFileSync(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`)
  vaultManifest.optionalDependencies = vaultOptionalDependencies
  writeFileSync(vaultManifestPath, `${JSON.stringify(vaultManifest, null, 2)}\n`)
  process.stdout.write(
    `Prepared ${Object.keys(NATIVE_TARGETS).length} platform packages and the root optional dependency manifest.\n`,
  )
} else {
  throw new Error('Usage: node scripts/native-release.mjs stage <target> | prepare [--root dir]')
}
