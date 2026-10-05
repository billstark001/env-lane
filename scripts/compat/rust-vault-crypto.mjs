import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runRustExample, withOracle, workspace } from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const fixture = JSON.parse(
    readFileSync(path.join(workspace, 'compat/fixtures/vault/schema-v0-v1.json'), 'utf8'),
  )
  const keyFile = path.join(temporary, 'synthetic-key.txt')
  writeFileSync(keyFile, fixture.keyMaterialUtf8)
  const key = legacy.deriveVaultKey(keyFile)
  const plaintexts = [
    ...fixture.records.map((record) => record.plaintext),
    ...Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        version: 1,
        f: 'apps/api/.env',
        k: `SYNTHETIC_${index}`,
        t: 1700000000000 + index,
        op: 'set',
        v: `value ${index} 日本語\nquoted " # \\`,
      }),
    ),
    JSON.stringify({ version: 1, f: '.env', k: 'REMOVED', t: 1700000005000, op: 'delete' }),
  ]
  const ciphertexts = plaintexts.map((value) => legacy.encryptRecord(key, value))
  const [result] = runRustExample('vault-crypto-protocol', [
    { keyFile, decrypt: ciphertexts, encrypt: plaintexts, fingerprint: fixture.fingerprintInput },
  ])
  assert.deepEqual(
    result.decrypt,
    plaintexts.map((plaintext) => ({ plaintext })),
  )
  assert.deepEqual(
    result.encrypt.map((encrypted) => legacy.decryptRecord(key, encrypted)),
    plaintexts,
  )
  assert.equal(result.fingerprint, fixture.fingerprintHex)
  assert.equal(new Set(result.encrypt).size, plaintexts.length)
  process.stdout.write(
    `Rust Vault crypto: ${plaintexts.length} records crossed both directions against frozen Node crypto.\n`,
  )
})
