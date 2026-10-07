import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NATIVE_TARGETS } from '../native-targets.mjs'
import { npmPublishArgs } from '../publish-release.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixture = mkdtempSync(path.join(tmpdir(), 'env-lane-platform-packages-'))
try {
  for (const packageName of ['native', 'vault']) {
    const destination = path.join(fixture, 'packages', packageName)
    mkdirSync(destination, { recursive: true })
    copyFileSync(
      path.join(root, 'packages', packageName, 'package.json'),
      path.join(destination, 'package.json'),
    )
    const manifestPath = path.join(destination, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = packageName === 'native' ? '0.5.2' : '0.5.1'
    writeFileSync(manifestPath, JSON.stringify(manifest))
  }
  for (const [triple, suffix] of Object.entries(NATIVE_TARGETS)) {
    const directory = path.join(fixture, 'native-artifacts', `native-${suffix}`)
    mkdirSync(directory, { recursive: true })
    const binary = triple.includes('windows') ? 'env-lane.exe' : 'env-lane'
    const plugin = triple.includes('windows')
      ? 'env-lane-plugin-vault.exe'
      : 'env-lane-plugin-vault'
    for (const name of [`env-lane-native.${suffix}.node`, binary, plugin]) {
      writeFileSync(path.join(directory, name), Buffer.alloc(100_001, 0x41))
    }
  }
  for (const args of [
    ['scripts/prepare-standalone-release.mjs', '--root', fixture],
    ['scripts/native-release.mjs', 'prepare', '--root', fixture],
    ['scripts/verify-native-packages.mjs', '--root', fixture],
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, args[0]), ...args.slice(1)], {
      cwd: fixture,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  }
  const native = JSON.parse(readFileSync(path.join(fixture, 'packages/native/package.json')))
  const vault = JSON.parse(readFileSync(path.join(fixture, 'packages/vault/package.json')))
  assert.equal(Object.keys(native.optionalDependencies).length, 8)
  assert.equal(Object.keys(vault.optionalDependencies).length, 8)
  assert.equal(native.version, '0.5.2')
  assert.equal(vault.version, '0.5.1')
  assert.ok(Object.values(native.optionalDependencies).every((version) => version === '0.5.2'))
  assert.ok(Object.values(vault.optionalDependencies).every((version) => version === '0.5.1'))
  for (const packageName of ['native', 'vault']) {
    const directory = path.join(fixture, 'packages', packageName, 'npm/darwin-arm64')
    const published = spawnSync('npm', [...npmPublishArgs(directory), '--dry-run', '--json'], {
      cwd: fixture,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    assert.equal(published.status, 0, published.stderr)
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(Object.values(JSON.parse(published.stdout))[0].name, manifest.name)
  }
  for (const suffix of Object.values(NATIVE_TARGETS)) {
    const archive = path.join(fixture, 'release-files', `env-lane-${suffix}.tar.gz`)
    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    assert.ok(listed.stdout.includes(`./plugins/@env-lane/vault-native-${suffix}/package.json`))
  }
  process.stdout.write('Derived native and Vault platform packages passed pack verification.\n')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
