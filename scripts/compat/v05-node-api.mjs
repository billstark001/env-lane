import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import native from '../../packages/native/index.js'

const root = path.resolve(import.meta.dirname, '../..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
process.env.ENV_LANE_PLUGIN_PACKAGE_ROOT = path.join(root, 'target/debug')
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href)
const vault = await import(pathToFileURL(path.join(root, 'packages/vault/dist/index.js')).href)
const fixture = mkdtempSync(path.join(tmpdir(), 'env-lane-v05-node-'))
try {
  writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ name: 'synthetic-api-fixture' }),
  )
  writeFileSync(
    path.join(fixture, 'env-lane.config.json'),
    JSON.stringify({ vault: { enabled: true } }),
  )
  writeFileSync(path.join(fixture, 'env-lane.vault.json'), JSON.stringify({ envFiles: ['.env'] }))
  const loaded = await core.loadEnvLaneConfig({ cwd: fixture })
  assert.equal(loaded.vault.enabled, true)
  const vaultConfig = await vault.loadVaultConfig(undefined, { cwd: fixture })
  assert.deepEqual(vaultConfig.envFiles, [path.join(realpathSync(fixture), '.env')])
  const unknown = JSON.parse(
    native.invoke('missing.operation', JSON.stringify({ projectRoot: fixture })),
  )
  assert.equal(unknown.error.code, 'INVALID_NATIVE_OPERATION')
  const disabled = JSON.parse(
    native.invoke(
      'vault.validateConfig',
      JSON.stringify({
        projectRoot: fixture,
        hostConfig: { ...loaded, vault: { enabled: false, configFile: 'env-lane.vault' } },
        config: vaultConfig,
      }),
    ),
  )
  assert.equal(disabled.error.code, 'INVALID_NATIVE_OPERATION')
  process.stdout.write(`${version} Node config and namespace conformance passed.\n`)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
