import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'
import { vaultPlatformManifest } from './platform-packages.mjs'

if (process.argv[2] === '--root' && !process.argv[3]) {
  throw new Error('--root requires a directory')
}
const root =
  process.argv[2] === '--root'
    ? path.resolve(process.argv[3])
    : path.resolve(import.meta.dirname, '..')
const artifactRoot = path.join(root, 'native-artifacts')
const output = path.join(root, 'release-files')
const vaultManifest = JSON.parse(
  readFileSync(path.join(root, 'packages/vault/package.json'), 'utf8'),
)
mkdirSync(output, { recursive: true })
const checksums = []
for (const suffix of Object.values(NATIVE_TARGETS)) {
  const source = path.join(artifactRoot, `native-${suffix}`)
  const binary = suffix.startsWith('win32') ? 'env-lane.exe' : 'env-lane'
  const plugin = suffix.startsWith('win32') ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
  const addon = `env-lane-native.${suffix}.node`
  const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-standalone-'))
  try {
    const vault = path.join(temporary, 'plugins/@env-lane/vault')
    const platform = path.join(temporary, `plugins/@env-lane/vault-native-${suffix}`)
    mkdirSync(vault, { recursive: true })
    mkdirSync(platform, { recursive: true })
    for (const [from, to] of [
      [path.join(source, binary), path.join(temporary, binary)],
      [path.join(source, plugin), path.join(platform, plugin)],
      [path.join(root, 'packages/vault/package.json'), path.join(vault, 'package.json')],
    ]) {
      assert.ok(existsSync(from), `Missing standalone input ${from}`)
      copyFileSync(from, to)
    }
    writeFileSync(
      path.join(platform, 'package.json'),
      `${JSON.stringify(vaultPlatformManifest(suffix, vaultManifest.version), null, 2)}\n`,
    )
    const archive = `env-lane-${suffix}.tar.gz`
    const packed = spawnSync('tar', ['-czf', path.join(output, archive), '-C', temporary, '.'], {
      encoding: 'utf8',
    })
    assert.equal(packed.status, 0, packed.stderr)
    const addonName = addon
    copyFileSync(path.join(source, addon), path.join(output, addonName))
    for (const name of [archive, addonName]) {
      const checksum = createHash('sha256')
        .update(readFileSync(path.join(output, name)))
        .digest('hex')
      checksums.push(`${checksum}  ${name}`)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
writeFileSync(path.join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
process.stdout.write(`Prepared ${checksums.length} release files and SHA256SUMS.\n`)
