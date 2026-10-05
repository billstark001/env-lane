import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const entries = [
  ['core', 'index', ['defineConfig', 'loadEnvLaneConfig', 'resolveInjectedEnv', 'sortEnvFile']],
  ['core', 'env-document', ['parseEnvDocument', 'parseEnvLine']],
  ['vault', 'index', ['defineVaultConfig', 'loadVaultConfig', 'encryptEnvFiles']],
  ['vault', 'cli/index', ['registerVaultCommands', 'VAULT_CLI_API_VERSION']],
  ['cli', 'index', ['defineConfig', 'loadEnvLaneConfig']],
]
for (const [pkg, entry, stable] of entries) {
  const base = path.join(root, 'packages', pkg, 'dist', entry)
  for (const extension of ['js', 'cjs', 'd.ts']) assert.ok(existsSync(`${base}.${extension}`))
  const esm = await import(pathToFileURL(`${base}.js`).href)
  const cjs = require(`${base}.cjs`)
  for (const item of stable) {
    assert.ok(item in esm, `${pkg}/${entry} ESM missing ${item}`)
    assert.ok(item in cjs, `${pkg}/${entry} CJS missing ${item}`)
  }
}
// biome-ignore lint/security/noSecrets: These are public API symbol names.
const removed = ['parseEnvDocument', 'listEnvFilesForTarget', 'writeFileContentAtomically']
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href)
for (const item of removed)
  assert.ok(!(item in core), `Deprecated Core root export remains: ${item}`)
const vault = await import(pathToFileURL(path.join(root, 'packages/vault/dist/index.js')).href)
for (const item of ['registerVaultCommands', 'deriveVaultKey'])
  assert.ok(!(item in vault), `Deprecated Vault root export remains: ${item}`)
const sdk = await import(pathToFileURL(path.join(root, 'packages/plugin-sdk/index.mjs')).href)
assert.equal(sdk.PROTOCOL_VERSION, 1)
const cli = path.join(root, 'packages/cli/dist/env-lane')
assert.ok(existsSync(cli), 'Native CLI missing from npm bin path')
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' })
assert.equal(version.status, 0)
assert.equal(version.stdout.trim(), '0.5.0')
const fixture = mkdtempSync(path.join(tmpdir(), 'env-lane-built-smoke-'))
try {
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'synthetic-smoke' }))
  writeFileSync(
    path.join(fixture, 'env-lane.config.json'),
    JSON.stringify({ vault: { enabled: false } }),
  )
  const result = spawnSync(cli, ['--cwd', fixture, 'packages', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Array.isArray(JSON.parse(result.stdout)))
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
process.stdout.write('0.5.0 package entries and native CLI smoke passed\n')
