import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeRoot, runRustExample, withOracle, workspace } from './rust-support.mjs'

function normalize(value, root) {
  const result = normalizeRoot(value, root)
  if (result && typeof result === 'object') {
    if (Array.isArray(result)) return result.map((item) => normalize(item, root))
    return Object.fromEntries(
      Object.entries(result)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, key === 'createdAt' ? '$TIME' : normalize(item, root)]),
    )
  }
  return result
}

await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const source = path.join(workspace, 'compat/fixtures/topologies/moment-landing')
  const nodeRoot = path.join(temporary, 'node-restore')
  const rustRoot = path.join(temporary, 'rust-restore')
  cpSync(source, nodeRoot, { recursive: true })
  cpSync(source, rustRoot, { recursive: true })
  for (const root of [nodeRoot, rustRoot]) {
    const file = path.join(root, 'env-lane.vault.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.restore = { redaction: 'full', reveal: false, promptLoop: false }
    writeFileSync(file, JSON.stringify(config))
  }
  await legacy.encryptEnvFiles(undefined, path.join(nodeRoot, 'key.txt'), {
    cwd: nodeRoot,
    vaultConfigFile: 'env-lane.vault.json',
  })
  mkdirSync(path.join(rustRoot, '.env-lane-vault'), { recursive: true })
  cpSync(
    path.join(nodeRoot, '.env-lane-vault/store.dat'),
    path.join(rustRoot, '.env-lane-vault/store.dat'),
  )
  writeFileSync(path.join(nodeRoot, '.env'), 'PUBLIC_ORIGIN=https://changed.invalid\n')
  writeFileSync(path.join(rustRoot, '.env'), 'PUBLIC_ORIGIN=https://changed.invalid\n')
  const expected = await legacy.buildRestorePlan(undefined, path.join(nodeRoot, 'key.txt'), {
    cwd: nodeRoot,
    vaultConfigFile: 'env-lane.vault.json',
  })
  const request = {
    cwd: rustRoot,
    mainConfig: 'env-lane.config.json',
    vaultConfig: 'env-lane.vault.json',
    keyFile: path.join(rustRoot, 'key.txt'),
  }
  const [actual] = runRustExample('vault-restore-protocol', [request])
  assert.deepEqual(normalize(actual, rustRoot), normalize(expected, nodeRoot))
  const applied = await legacy.applyRestorePlan(
    undefined,
    path.join(nodeRoot, 'key.txt'),
    expected,
    { cwd: nodeRoot, vaultConfigFile: 'env-lane.vault.json', autoApprove: true },
  )
  const [nativeApplied] = runRustExample('vault-restore-protocol', [
    { ...request, operation: 'apply', plan: actual, autoApprove: true },
  ])
  assert.deepEqual(normalize(nativeApplied, rustRoot), normalize(applied, nodeRoot))
  assert.equal(
    readFileSync(path.join(rustRoot, '.env'), 'utf8'),
    readFileSync(path.join(nodeRoot, '.env'), 'utf8'),
  )
  process.stdout.write('Rust Vault restore: frozen plan, apply result and dotenv bytes matched.\n')
})
