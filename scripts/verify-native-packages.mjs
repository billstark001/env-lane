import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const root = path.resolve(import.meta.dirname, '..')
const nativeDir = path.join(root, 'packages/native')
const manifest = JSON.parse(readFileSync(path.join(nativeDir, 'package.json'), 'utf8'))
assert.deepEqual(new Set(manifest.napi.targets), new Set(Object.keys(NATIVE_TARGETS)))
assert.equal(
  Object.keys(manifest.optionalDependencies ?? {}).length,
  Object.keys(NATIVE_TARGETS).length,
)
for (const [triple, suffix] of Object.entries(NATIVE_TARGETS)) {
  const directory = path.join(nativeDir, 'npm', suffix)
  const platform = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const addon = `env-lane-native.${suffix}.node`
  const binary = triple.includes('windows') ? 'env-lane.exe' : 'env-lane'
  assert.equal(platform.name, `@env-lane/native-${suffix}`)
  assert.equal(platform.version, manifest.version)
  assert.equal(manifest.optionalDependencies[platform.name], manifest.version)
  assert.deepEqual(new Set(platform.files), new Set([addon, binary]))
  for (const file of [addon, binary]) {
    const full = path.join(directory, file)
    assert.ok(existsSync(full) && statSync(full).size > 100_000, `Missing ${full}`)
  }
  const packed = spawnSync('npm', ['pack', directory, '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stderr)
  const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path))
  assert.ok(files.has(addon) && files.has(binary), `Platform tarball missing files for ${suffix}`)
}
process.stdout.write(
  `Verified ${Object.keys(NATIVE_TARGETS).length} platform packages and tarballs.\n`,
)
