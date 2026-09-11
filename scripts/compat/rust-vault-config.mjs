import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { plainValue, runRustExample, withOracle } from './rust-support.mjs'

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const root = path.join(temporary, 'project')
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), '{}')
  const mainConfig = path.join(root, 'env-lane.config.json')
  writeFileSync(mainConfig, JSON.stringify({ vault: { disableUnsafeWarning: true } }))
  const requests = []
  const expected = []
  const configs = [
    { envFiles: [] },
    { envFiles: ['../.env', '../.env', './.env'] },
    {
      envFiles: ['../.env'],
      outputDir: '../history',
      outputFile: 'records',
      trackDeletions: false,
      autoRemapPaths: false,
      allowUnmanaged: true,
    },
    {
      envFiles: [],
      restore: { redaction: 'partial', reveal: { start: 2 }, promptLoop: true },
      exclude: [{ files: [' **/.env '], keys: [' TOKEN '] }],
    },
    {
      envFiles: [],
      disableUnsafeWarning: false,
      sort: {
        app: {
          file: '../.env',
          template: '../example',
          files: { production: '../.env.production' },
        },
      },
    },
  ]
  for (const [index, config] of configs.entries()) {
    const vaultConfig = path.join(root, 'config', `vault-${index}.json`)
    writeFileSync(vaultConfig, JSON.stringify(config))
    requests.push({ cwd: root, mainConfig, vaultConfig })
    expected.push(
      plainValue(
        await legacy.loadVaultConfig(mainConfig, { cwd: root, vaultConfigFile: vaultConfig }),
      ),
    )
  }
  const actual = runRustExample('vault-config-protocol', requests)
  actual.forEach((value, index) => {
    assert.deepEqual(value, expected[index], `Vault config ${index}`)
  })
  process.stdout.write(`Rust Vault canonical config: ${requests.length} cases passed\n`)
})
