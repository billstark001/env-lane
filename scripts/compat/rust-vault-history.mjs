import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runRustExample, withOracle } from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const keyFile = path.join(temporary, 'synthetic-key')
  writeFileSync(keyFile, 'synthetic-prune-interoperability')
  const key = legacy.deriveVaultKey(keyFile)
  const lines = []
  for (const [name, time] of [
    ['A', 1],
    ['A', 2],
    ['A', 2],
    ['B', 3],
    ['B', 1],
  ]) {
    lines.push(
      legacy.encryptRecord(
        key,
        JSON.stringify({ version: 1, f: '.env', k: name, t: time, op: 'set', v: 'synthetic' }),
      ),
    )
  }
  lines.push('unreadable')
  const cases = []
  const expected = []
  for (const keepRecent of [1, 2, 8]) {
    for (const selectedKey of [undefined, 'A']) {
      for (const apply of [false, true]) {
        const storePath = path.join(temporary, `node-${cases.length}.dat`)
        const nativePath = path.join(temporary, `rust-${cases.length}.dat`)
        writeFileSync(storePath, lines.join('\n'))
        writeFileSync(nativePath, lines.join('\n'))
        const config = {
          baseDir: temporary,
          envFiles: [],
          outputDir: temporary,
          outputFile: path.basename(storePath),
          storePath,
          trackDeletions: true,
          autoRemapPaths: false,
          allowUnmanaged: false,
          restore: { redaction: 'none', reveal: false, promptLoop: false },
          exclude: [],
          disableUnsafeWarning: true,
        }
        const { storePath: _path, ...result } = await legacy.pruneVaultHistory(undefined, keyFile, {
          cwd: temporary,
          resolvedConfig: config,
          keepRecent,
          key: selectedKey,
          dryRun: !apply,
          autoApprove: true,
          ignoreCorruptRecords: true,
        })
        expected.push({ ...result, lines: readFileSync(storePath, 'utf8').trim().split('\n') })
        cases.push({ path: nativePath, keepRecent, key: selectedKey, apply })
      }
    }
  }
  const [actual] = runRustExample('vault-history-protocol', [{ base: temporary, keyFile, cases }])
  actual.forEach((value, index) => {
    assert.deepEqual(value, expected[index], `history case ${index}`)
  })
  process.stdout.write(
    `Rust Vault history: ${cases.length} preview/apply observations matched frozen Node\n`,
  )
})
