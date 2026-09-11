import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runRustExample, withOracle } from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const keyFile = path.join(temporary, 'synthetic-key')
  writeFileSync(keyFile, 'synthetic-sync-interoperability')
  const key = legacy.deriveVaultKey(keyFile)
  const syncKey = legacy.deriveVaultSyncKey(key)
  const fingerprint = (value) =>
    legacy.keyedDigest(
      syncKey,
      JSON.stringify(value === null ? { op: 'delete' } : { op: 'set', v: value }),
    )
  const requests = []
  const expected = []
  for (const baseline of [undefined, null, '', 'baseline']) {
    for (const [local, vault] of [
      [null, 'remote'],
      ['', 'remote'],
      ['local', 'remote'],
      ['local', 'baseline'],
      ['baseline', 'remote'],
      ['same', 'same'],
      [null, null],
    ]) {
      const base = path.join(temporary, `case-${requests.length}`)
      const syncDir = path.join(base, 'sync')
      mkdirSync(syncDir, { recursive: true })
      if (local !== null) writeFileSync(path.join(base, '.env'), `A=${local}\n`)
      const storePath = path.join(base, 'store.dat')
      writeFileSync(
        storePath,
        legacy.encryptRecord(
          key,
          JSON.stringify({
            version: 1,
            f: '.env',
            k: 'A',
            t: 100,
            op: vault === null ? 'delete' : 'set',
            ...(vault === null ? {} : { v: vault }),
          }),
        ),
      )
      const entries =
        baseline === undefined
          ? {}
          : {
              [legacy.stableHash('.env\0A')]: {
                filePath: '.env',
                key: 'A',
                op: baseline === null ? 'delete' : 'set',
                valueFingerprint: fingerprint(baseline),
                vaultTimestamp: 1,
                syncedAt: 2,
              },
            }
      writeFileSync(
        path.join(syncDir, 'vault-sync-state.json'),
        JSON.stringify({ version: 1, fingerprint: 'hmac-sha256', entries }),
      )
      const config = {
        baseDir: base,
        envFiles: [path.join(base, '.env')],
        outputDir: base,
        outputFile: 'store.dat',
        storePath,
        trackDeletions: true,
        autoRemapPaths: true,
        allowUnmanaged: false,
        restore: { redaction: 'none', reveal: false, promptLoop: false },
        exclude: [],
        disableUnsafeWarning: true,
      }
      const plan = await legacy.buildRestorePlan(undefined, keyFile, {
        cwd: base,
        resolvedConfig: config,
        syncDir,
      })
      const entry = plan.files.flatMap((file) => file.entries)[0]
      expected.push({ fingerprint: fingerprint(local), reason: entry?.conflictReason ?? null })
      requests.push({ base, syncDir, keyFile, local, vault })
    }
  }
  const actual = runRustExample('vault-sync-protocol', requests)
  actual.forEach((value, index) => {
    assert.deepEqual(value, expected[index], `sync case ${index}`)
  })
  process.stdout.write(
    `Rust Vault sync: ${requests.length} fingerprint and three-way conflict cases passed\n`,
  )
})
