import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { workspace } from './rust-support.mjs'

const require = createRequire(import.meta.url)
const { platformSuffix } = require('../../packages/native/bin.cjs')
const build = spawnSync(
  'cargo',
  ['build', '--locked', '--bin', 'env-lane', '--bin', 'env-lane-plugin-vault'],
  { cwd: workspace, encoding: 'utf8' },
)
assert.equal(build.status, 0, build.stderr)
const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-native-install-'))
const binaryName = process.platform === 'win32' ? 'env-lane.exe' : 'env-lane'
const pluginName =
  process.platform === 'win32' ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
const installed = path.join(temporary, 'node_modules/env-lane')
const vault = path.join(temporary, 'node_modules/@env-lane/vault')
const platform = path.join(temporary, `node_modules/@env-lane/vault-native-${platformSuffix()}`)
try {
  mkdirSync(path.join(installed, 'dist'), { recursive: true })
  copyFileSync(
    path.join(workspace, 'target/debug', binaryName),
    path.join(installed, 'dist', binaryName),
  )
  writeFileSync(
    path.join(temporary, 'package.json'),
    JSON.stringify({ name: 'synthetic-install-fixture' }),
  )
  writeFileSync(
    path.join(temporary, 'env-lane.config.json'),
    JSON.stringify({ vault: { enabled: true } }),
  )
  writeFileSync(path.join(temporary, 'env-lane.vault.json'), JSON.stringify({ envFiles: [] }))
  const invoke = () => {
    const result = spawnSync(
      path.join(installed, 'dist', binaryName),
      ['--json', 'vault', 'plan', 'missing-key'],
      {
        cwd: temporary,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
      },
    )
    assert.equal(result.status, 1)
    return JSON.parse(result.stdout).error.code
  }
  assert.equal(invoke(), 'PLUGIN_NOT_INSTALLED')
  mkdirSync(vault, { recursive: true })
  const metadata = JSON.parse(
    readFileSync(path.join(workspace, 'packages/vault/package.json'), 'utf8'),
  )
  const expectedProtocol = metadata.envLanePlugin.protocolVersion
  metadata.envLanePlugin.protocolVersion = expectedProtocol + 98
  writeFileSync(path.join(vault, 'package.json'), JSON.stringify(metadata))
  assert.equal(invoke(), 'PLUGIN_PACKAGE_INVALID')
  metadata.envLanePlugin.protocolVersion = expectedProtocol
  writeFileSync(path.join(vault, 'package.json'), JSON.stringify(metadata))
  mkdirSync(platform, { recursive: true })
  writeFileSync(
    path.join(platform, 'package.json'),
    JSON.stringify({ name: `@env-lane/vault-native-${platformSuffix()}` }),
  )
  copyFileSync(path.join(workspace, 'target/debug', pluginName), path.join(platform, pluginName))
  assert.equal(invoke(), 'VAULT_KEY_NOT_FOUND')
  process.stdout.write('Generic npm native plugin discovery and no-Node startup passed.\n')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
