import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
  const directory = path.join(temporary, 'store-cases')
  mkdirSync(directory)
  const root = realpathSync(directory)
  const keyFile = path.join(root, 'synthetic-key.txt')
  writeFileSync(keyFile, fixture.keyMaterialUtf8)
  const key = legacy.deriveVaultKey(keyFile)
  const valid = fixture.records.map((record) => record.ciphertext)
  const encode = (record) =>
    legacy.encryptRecord(key, typeof record === 'string' ? record : JSON.stringify(record))
  const base = {
    version: 1,
    f: '.env',
    k: 'MODERN',
    t: 1700000001000,
    op: 'set',
    v: 'same-time-newer-line',
  }
  const cases = [
    { lines: valid },
    { lines: valid, autoRemapPaths: false },
    { lines: [...valid, encode(base), encode({ ...base, t: 1, v: 'older' })] },
    { lines: [...valid, encode({ ...base, op: 'delete' })] },
    { lines: ['corrupt'] },
    { lines: [...valid, 'corrupt'] },
    { lines: [...valid, 'corrupt'], ignoreCorruptRecords: true },
    { lines: ['corrupt'], ignoreCorruptRecords: true },
    { lines: [] },
    { lines: [encode({ ...base, t: '1700000001000' })] },
    { lines: [encode('{"version":1.0,"f":".env","k":"A","t":0,"v":"decimal-version"}')] },
    { lines: [encode({ ...base, version: 2 })] },
    { lines: [encode({ ...base, f: 'C:/unsafe-path' })] },
    {
      lines: valid.map((line) => line.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')),
    },
    { lines: valid.map((line) => `${line.slice(0, 8)} ! ${line.slice(8)}`) },
  ]
  const expected = []
  for (const [index, item] of cases.entries()) {
    item.storePath = path.join(root, `store-${index}.dat`)
    writeFileSync(item.storePath, `\uFEFF\r\n${item.lines.join('\r\n')}\r\n`)
    const config = {
      baseDir: root,
      envFiles: [path.join(root, '.env')],
      outputDir: root,
      outputFile: path.basename(item.storePath),
      storePath: item.storePath,
      autoRemapPaths: item.autoRemapPaths ?? true,
      trackDeletions: true,
      allowUnmanaged: false,
      restore: { redaction: 'none', reveal: false, promptLoop: false },
      exclude: [],
      disableUnsafeWarning: true,
    }
    try {
      const plan = await legacy.buildRestorePlan(undefined, keyFile, {
        cwd: root,
        resolvedConfig: config,
        ignoreCorruptRecords: item.ignoreCorruptRecords,
      })
      expected.push({
        failedRecords: plan.failedRecords,
        parsedRecords: plan.parsedRecords,
        rawRecords: plan.rawRecords,
        aliasedRecords: plan.aliasedRecords,
        entries: plan.files.flatMap((file) =>
          file.entries.map((entry) => ({
            file: file.filePath,
            key: entry.key,
            value: entry.preview.vault,
          })),
        ),
      })
    } catch (error) {
      expected.push({ error: error.code, message: error.message })
    }
  }
  const [actual] = runRustExample('vault-store-protocol', [
    { root, keyFile, managedFiles: ['.env'], cases },
  ])
  for (const [index, observation] of actual.entries())
    assert.deepEqual(observation, expected[index], `Vault store case ${index}`)
  process.stdout.write(
    `Rust Vault store: ${cases.length} read/failure observations matched frozen Node.\n`,
  )
})
