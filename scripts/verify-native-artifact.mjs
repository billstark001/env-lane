import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const root = path.resolve(import.meta.dirname, '..')
const triple = process.argv[2]
assert.ok(triple && Object.hasOwn(NATIVE_TARGETS, triple), 'Pass a supported target triple')
const suffix = NATIVE_TARGETS[triple]
const directory = path.join(root, 'native-artifacts', `native-${suffix}`)
const addon = path.join(directory, `env-lane-native.${suffix}.node`)
const binary = path.join(directory, triple.includes('windows') ? 'env-lane.exe' : 'env-lane')
const plugin = path.join(
  directory,
  triple.includes('windows') ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault',
)
for (const file of [addon, binary, plugin]) {
  assert.ok(
    existsSync(file) && statSync(file).size > 100_000,
    `Missing or truncated artifact ${file}`,
  )
}
const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr || result.error?.message)
const manifest = JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'))
assert.equal(result.stdout.trim().split(/\s+/).at(-1), manifest.version)
if (!triple.includes('musl')) {
  const native = createRequire(import.meta.url)(addon)
  assert.equal(typeof native.invoke, 'function')
  assert.equal(JSON.parse(native.invoke('invalid', '{}')).error.code, 'INVALID_NATIVE_OPERATION')
}
process.stdout.write(`Verified ${suffix} native CLI, Vault plugin, and Node addon artifacts.\n`)
