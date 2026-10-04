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
  assert.ok(existsSync(sourceAddon), `Missing Node addon: ${sourceAddon}`)
  assert.ok(existsSync(sourceBinary), `Missing CLI binary: ${sourceBinary}`)
  const destination = path.join(artifactRoot, `native-${suffix}`)
  mkdirSync(destination, { recursive: true })
  copyFileSync(sourceAddon, path.join(destination, path.basename(sourceAddon)))
  copyFileSync(sourceBinary, path.join(destination, binaryName))
  process.stdout.write(`${destination}\n`)
} else if (mode === 'prepare') {
  const optionalDependencies = {}
  for (const [triple, suffix] of Object.entries(NATIVE_TARGETS)) {
    const source = path.join(artifactRoot, `native-${suffix}`)
    const packageDir = path.join(root, 'packages/native/npm', suffix)
    const packageManifestPath = path.join(packageDir, 'package.json')
    const addonName = `env-lane-native.${suffix}.node`
    const binaryName = triple.includes('windows') ? 'env-lane.exe' : 'env-lane'
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
  }
  nativeManifest.optionalDependencies = optionalDependencies
  writeFileSync(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`)
  process.stdout.write(
    `Prepared ${Object.keys(NATIVE_TARGETS).length} platform packages and the root optional dependency manifest.\n`,
  )
} else {
  throw new Error('Usage: node scripts/native-release.mjs stage <target> | prepare')
}
