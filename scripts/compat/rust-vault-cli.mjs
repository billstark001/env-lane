import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeRoot, withOracle, workspace } from './rust-support.mjs'

const build = spawnSync(
  'cargo',
  ['build', '--locked', '--bin', 'env-lane', '--bin', 'env-lane-plugin-vault'],
  {
    cwd: workspace,
    encoding: 'utf8',
  },
)
assert.equal(build.status, 0, build.stderr)
const native = path.join(
  workspace,
  'target/debug',
  process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
)

function assertSkippedApproval(run, root) {
  run(
    native,
    root,
    ['plan', 'key.txt', '--vault-config', 'env-lane.vault.json', '--output', 'skip-plan.json'],
    false,
  )
  const approvalPath = path.join(root, 'skip-plan.json')
  const approval = JSON.parse(readFileSync(approvalPath, 'utf8'))
  for (const decision of approval.decisions) decision.decision = 'skip'
  writeFileSync(approvalPath, `${JSON.stringify(approval)}\n`)
  const skipped = run(
    native,
    root,
    [
      'apply',
      'key.txt',
      '--vault-config',
      'env-lane.vault.json',
      '--plan',
      'skip-plan.json',
      '--yes',
      '--fail-on',
      'change',
    ],
    false,
  )
  assert.equal(skipped.appliedEntries, 0)
  assert.equal(
    readFileSync(path.join(root, '.env'), 'utf8'),
    'PUBLIC_ORIGIN=https://changed.invalid\n',
  )
  assert.ok(approval.decisions.length > 0)
  approval.decisions.push(approval.decisions[0])
  writeFileSync(approvalPath, `${JSON.stringify(approval)}\n`)
  const invalid = spawnSync(
    native,
    [
      '--config',
      'env-lane.config.json',
      '--cwd',
      root,
      '--json',
      'vault',
      'apply',
      'key.txt',
      '--vault-config',
      'env-lane.vault.json',
      '--plan',
      'skip-plan.json',
      '--yes',
    ],
    { cwd: root, encoding: 'utf8' },
  )
  assert.notEqual(invalid.status, 0)
  assert.equal(JSON.parse(invalid.stdout || invalid.stderr).error.code, 'VAULT_INVALID_PLAN_FILE')
}

await withOracle(async ({ temporary, runtime }) => {
  const source = path.join(workspace, 'compat/fixtures/topologies/moment-landing')
  const nodeRoot = path.join(temporary, 'node-cli')
  const rustRoot = path.join(temporary, 'rust-cli')
  cpSync(source, nodeRoot, { recursive: true })
  cpSync(source, rustRoot, { recursive: true })
  const legacy = path.join(runtime, 'node_modules/env-lane/dist/cli.js')
  const run = (executable, root, args, viaNode) => {
    const result = spawnSync(
      viaNode ? process.execPath : executable,
      [
        ...(viaNode ? [executable] : []),
        '--config',
        'env-lane.config.json',
        '--cwd',
        root,
        '--json',
        'vault',
        ...args,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return normalizeRoot(JSON.parse(result.stdout), root)
  }
  for (const args of [
    ['encrypt', 'key.txt', '--vault-config', 'env-lane.vault.json', '--dry-run'],
    ['encrypt', 'key.txt', '--vault-config', 'env-lane.vault.json'],
  ]) {
    const expected = run(legacy, nodeRoot, args, true)
    const actual = run(native, rustRoot, args, false)
    assert.deepEqual(actual, expected)
  }
  cpSync(
    path.join(nodeRoot, '.env-lane-vault/store.dat'),
    path.join(rustRoot, '.env-lane-vault/store.dat'),
  )
  const invalidPrune = (executable, root, viaNode, days = '-1') => {
    const result = spawnSync(
      viaNode ? process.execPath : executable,
      [
        ...(viaNode ? [executable] : []),
        '--config',
        'env-lane.config.json',
        '--cwd',
        root,
        '--json',
        'vault',
        'prune',
        'key.txt',
        '--vault-config',
        'env-lane.vault.json',
        `--older-than-days=${days}`,
        '--dry-run',
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    return JSON.parse(result.stdout || result.stderr).error.code
  }
  assert.equal(invalidPrune(legacy, nodeRoot, true), 'VAULT_INVALID_PRUNE_OPTIONS')
  assert.equal(invalidPrune(native, rustRoot, false), 'VAULT_INVALID_PRUNE_OPTIONS')
  assert.equal(invalidPrune(native, rustRoot, false, '1e308'), 'VAULT_INVALID_PRUNE_OPTIONS')
  const planArgs = ['plan', 'key.txt', '--vault-config', 'env-lane.vault.json']
  const expectedPlan = run(legacy, nodeRoot, planArgs, true)
  const actualPlan = run(native, rustRoot, planArgs, false)
  delete expectedPlan.createdAt
  delete actualPlan.createdAt
  assert.deepEqual(actualPlan, expectedPlan)
  for (const root of [nodeRoot, rustRoot])
    writeFileSync(path.join(root, '.env'), 'PUBLIC_ORIGIN=https://changed.invalid\n')
  assertSkippedApproval(run, rustRoot)
  const filtered = [
    'plan',
    'key.txt',
    '--vault-config',
    'env-lane.vault.json',
    '--key',
    'PUBLIC_*',
    '--only',
    'modify',
  ]
  const nodeFiltered = run(legacy, nodeRoot, filtered, true)
  const rustFiltered = run(native, rustRoot, filtered, false)
  delete nodeFiltered.createdAt
  delete rustFiltered.createdAt
  assert.deepEqual(rustFiltered, nodeFiltered)
  const restored = ['decrypt', 'key.txt', '--vault-config', 'env-lane.vault.json', '--yes']
  const nodeRestored = run(legacy, nodeRoot, restored, true)
  const rustRestored = run(native, rustRoot, restored, false)
  delete nodeRestored.createdAt
  delete rustRestored.createdAt
  assert.deepEqual(rustRestored, nodeRestored)
  assert.equal(
    readFileSync(path.join(nodeRoot, '.env'), 'utf8'),
    readFileSync(path.join(rustRoot, '.env'), 'utf8'),
  )
  assert.equal(
    readFileSync(path.join(nodeRoot, '.env-lane-vault/store.dat'), 'utf8').split('\n').length,
    readFileSync(path.join(rustRoot, '.env-lane-vault/store.dat'), 'utf8').split('\n').length,
  )
  process.stdout.write(
    'Rust Vault CLI: encrypt, filtered plan, decrypt JSON and file bytes match frozen Node.\n',
  )
})
