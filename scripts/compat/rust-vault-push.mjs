import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeRoot, runRustExample, withOracle, workspace } from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const source = path.join(workspace, 'compat/fixtures/topologies/moment-landing')
  const nodeRoot = path.join(temporary, 'node-push')
  const rustRoot = path.join(temporary, 'rust-push')
  cpSync(source, nodeRoot, { recursive: true })
  cpSync(source, rustRoot, { recursive: true })
  const cases = [{ dryRun: true }, { dryRun: false }]
  for (const item of cases) {
    const expected = await legacy.encryptEnvFiles(undefined, path.join(nodeRoot, 'key.txt'), {
      cwd: nodeRoot,
      vaultConfigFile: 'env-lane.vault.json',
      dryRun: item.dryRun,
      syncDir: path.join(nodeRoot, 'sync'),
    })
    const [actual] = runRustExample('vault-push-protocol', [
      {
        cwd: rustRoot,
        mainConfig: 'env-lane.config.json',
        vaultConfig: 'env-lane.vault.json',
        keyFile: path.join(rustRoot, 'key.txt'),
        dryRun: item.dryRun,
        syncDir: path.join(rustRoot, 'sync'),
      },
    ])
    assert.deepEqual(normalizeRoot(actual, rustRoot), normalizeRoot(expected, nodeRoot))
    assert.equal(existsSync(path.join(rustRoot, '.env-lane-vault/store.dat')), !item.dryRun)
    if (!item.dryRun) {
      const nodeLines = readFileSync(path.join(nodeRoot, '.env-lane-vault/store.dat'), 'utf8')
        .trim()
        .split('\n')
      const rustLines = readFileSync(path.join(rustRoot, '.env-lane-vault/store.dat'), 'utf8')
        .trim()
        .split('\n')
      assert.equal(rustLines.length, nodeLines.length)
      const key = legacy.deriveVaultKey(path.join(rustRoot, 'key.txt'))
      const records = rustLines.map((line) => JSON.parse(legacy.decryptRecord(key, line)))
      assert.equal(
        records.every((record) => record.version === 1),
        true,
      )
    }
  }
  writeFileSync(path.join(nodeRoot, '.env'), 'A=modified\n')
  writeFileSync(path.join(rustRoot, '.env'), 'A=modified\n')
  const changedExpected = await legacy.encryptEnvFiles(undefined, path.join(nodeRoot, 'key.txt'), {
    cwd: nodeRoot,
    vaultConfigFile: 'env-lane.vault.json',
    syncDir: path.join(nodeRoot, 'sync'),
  })
  const [changedActual] = runRustExample('vault-push-protocol', [
    {
      cwd: rustRoot,
      mainConfig: 'env-lane.config.json',
      vaultConfig: 'env-lane.vault.json',
      keyFile: path.join(rustRoot, 'key.txt'),
      syncDir: path.join(rustRoot, 'sync'),
    },
  ])
  assert.deepEqual(normalizeRoot(changedActual, rustRoot), normalizeRoot(changedExpected, nodeRoot))
  process.stdout.write(
    'Rust Vault push: dry-run, first write, updates and deletes match frozen Node; ciphertext cross-decrypts.\n',
  )
})
