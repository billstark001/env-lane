import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const root = path.resolve(import.meta.dirname, '..')
const artifactRoot = path.join(root, 'native-artifacts')
const output = path.join(root, 'release-files')
const targets = Object.values(NATIVE_TARGETS)
mkdirSync(output, { recursive: true })
const checksums = []
for (const suffix of targets) {
  const source = path.join(artifactRoot, `native-${suffix}`)
  const binary = suffix.startsWith('win32') ? 'env-lane.exe' : 'env-lane'
  const plugin = suffix.startsWith('win32') ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
  const addon = `env-lane-native.${suffix}.node`
  for (const [name, releaseName] of [
    [binary, suffix.startsWith('win32') ? `env-lane-${suffix}.exe` : `env-lane-${suffix}`],
    [
      plugin,
      suffix.startsWith('win32')
        ? `env-lane-plugin-vault-${suffix}.exe`
        : `env-lane-plugin-vault-${suffix}`,
    ],
    [addon, addon],
  ]) {
    const from = path.join(source, name)
    assert.ok(existsSync(from), `Missing native release artifact ${from}`)
    const to = path.join(output, releaseName)
    copyFileSync(from, to)
    const checksum = createHash('sha256').update(readFileSync(to)).digest('hex')
    checksums.push(`${checksum}  ${releaseName}`)
  }
}
writeFileSync(path.join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
process.stdout.write(`Prepared ${checksums.length} release files and SHA256SUMS.\n`)
