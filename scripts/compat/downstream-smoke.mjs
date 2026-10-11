import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyEnvDocumentPatches, parseEnvDocument } from '../../packages/core/dist/env-document.js'
import {
  loadEnvLaneConfig,
  sortEnvFile,
  sortEnvFilesFromConfig,
} from '../../packages/core/dist/index.js'
import { loadVaultConfig } from '../../packages/vault/dist/index.js'

const workspace = path.resolve(import.meta.dirname, '../..')
const executable = path.join(
  workspace,
  'target/debug',
  process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
)
process.env.ENV_LANE_PLUGIN_PACKAGE_ROOT = path.join(workspace, 'target/debug')
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'env-lane-downstream-')))

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}
function snapshot(files) {
  return files.map((file) => [file, existsSync(file) ? digest(readFileSync(file)) : null])
}
function effectiveDigest(file) {
  const entries = [...parseEnvDocument(readFileSync(file, 'utf8')).currentMap]
    .map(([key, value]) => [key, value.effectiveValue])
    .sort(([left], [right]) => left.localeCompare(right))
  return digest(JSON.stringify(entries))
}
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
function relative(root, file) {
  const result = path.relative(root, file)
  assert.ok(!path.isAbsolute(result) && result !== '..' && !result.startsWith(`..${path.sep}`))
  return result
}
function run(root, args, statuses = [0], json = true) {
  const config = path.join(root, 'env-lane.config.json')
  const result = spawnSync(
    executable,
    [
      '--cwd',
      root,
      ...(existsSync(config) ? ['--config', config] : []),
      ...(json ? ['--json'] : []),
      '--non-interactive',
      ...args,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  )
  assert.ifError(result.error)
  // Assertions and logs must never expose downstream dotenv values.
  const code = /"code"\s*:\s*"([A-Z_]+)"/.exec(result.stdout)?.[1] ?? 'unknown error'
  assert.ok(statuses.includes(result.status), `${args[0]} exited with ${result.status}: ${code}`)
  return json ? JSON.parse(result.stdout) : result.stdout
}
function envFiles(directories) {
  return directories.flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.env(?:\.|$)/.test(entry.name))
      .map((entry) => path.join(directory, entry.name)),
  )
}
function copyFiles(original, destination, files) {
  for (const file of new Set(files)) {
    if (!existsSync(file)) continue
    const target = path.join(destination, relative(original, file))
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(file, target)
  }
}
function remap(value, original, destination) {
  if (typeof value === 'string') {
    if (value === original) return destination
    return value.startsWith(`${original}${path.sep}`)
      ? destination + value.slice(original.length)
      : value
  }
  if (Array.isArray(value)) return value.map((item) => remap(item, original, destination))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, remap(item, original, destination)]),
    )
  }
  return value
}
function configureVault(root, files, exclude = []) {
  writeJson(path.join(root, 'smoke-vault.json'), {
    envFiles: files.map((file) => relative(root, file)),
    outputDir: '.test-vault',
    outputFile: 'store.dat',
    exclude,
    restore: { redaction: 'full', reveal: false },
    disableUnsafeWarning: true,
  })
  writeFileSync(path.join(root, 'smoke-key.txt'), 'synthetic-downstream-smoke-key\n')
}
function vaultCycle(root, files) {
  const before = files.filter(existsSync).map((file) => [file, effectiveDigest(file)])
  const encrypted = run(root, ['vault', 'encrypt', 'smoke-key.txt', '--sync-dir', '.vault-sync'])
  const change = encrypted.changes.find((item) => item.action === 'set')
  assert.ok(change, 'Expected at least one managed active variable')
  const file = path.resolve(root, change.filePath)
  applyEnvDocumentPatches(file, [{ op: 'set', key: change.key, value: 'synthetic-local-edit' }])
  const plan = run(root, ['vault', 'plan', 'smoke-key.txt', '--sync-dir', '.vault-sync'])
  assert.ok(plan.files.some((entry) => entry.changed))
  const restored = run(root, [
    'vault',
    'decrypt',
    'smoke-key.txt',
    '--sync-dir',
    '.vault-sync',
    '--yes',
    '--conflicts',
    'take-vault',
  ])
  assert.ok(restored.changes.some((item) => item.key === change.key && item.action === 'modify'))
  assert.ok(
    restored.changes.every(
      (item) => Object.keys(item).sort().join(',') === 'action,conflictResolved,filePath,key',
    ),
  )
  assert.deepEqual(
    files.filter(existsSync).map((item) => [item, effectiveDigest(item)]),
    before,
  )
  const second = run(root, [
    'vault',
    'decrypt',
    'smoke-key.txt',
    '--sync-dir',
    '.vault-sync',
    '--yes',
  ])
  assert.equal(second.changes.length, 0)
  return encrypted.changes.length
}

async function downstream(original, index) {
  original = realpathSync(original)
  const config = await loadEnvLaneConfig({ cwd: original })
  const packages = run(original, ['packages'])
  assert.ok(packages.length > 0)
  const vault = await loadVaultConfig(config.vault.configFile, { cwd: original })
  const directories = [...new Set([original, ...packages.map((item) => item.dir)])]
  const dotenvFiles = envFiles(directories)
  const tracked = [
    ...dotenvFiles,
    ...vault.envFiles,
    ...directories.map((directory) => path.join(directory, 'package.json')),
    path.join(original, '.env-lane-cache/sort-sync-state.json'),
    path.join(original, '.env-lane-cache/sort-sync-state.lock'),
  ]
  const originalBytes = snapshot(tracked)
  const preview = run(original, ['sort', '--check'], [0, 1])
  assert.ok(preview.count > 0)
  assert.deepEqual(snapshot(tracked), originalBytes)
  const destination = path.join(temporary, `project-${index}`)
  mkdirSync(destination)
  copyFiles(
    original,
    destination,
    tracked.filter((file) => !file.includes(`${path.sep}.env-lane-cache${path.sep}`)),
  )
  const { rootDir: _rootDir, ...rawConfig } = config
  const copied = remap(rawConfig, original, destination)
  // An empty resolved defaultTarget means no explicit target was configured.
  if (!copied.workspace.defaultTarget) delete copied.workspace.defaultTarget
  for (const settings of Object.values(copied.sort ?? {})) {
    if (settings.syncDir) relative(destination, path.resolve(destination, settings.syncDir))
  }
  copied.vault = { enabled: true, configFile: 'smoke-vault.json', disableUnsafeWarning: true }
  writeJson(path.join(destination, 'env-lane.config.json'), copied)
  const files = vault.envFiles.map((file) => path.join(destination, relative(original, file)))
  configureVault(destination, files, remap(vault.exclude, original, destination))
  const existing = dotenvFiles
    .filter((file) => !file.endsWith('.env.example'))
    .map((file) => path.join(destination, relative(original, file)))
  const before = existing.map((file) => [file, effectiveDigest(file)])
  const preflight = run(destination, ['sort', '--check'], [0, 1])
  for (const result of preflight.results) {
    relative(destination, result.filePath)
    relative(destination, result.templateFilePath)
  }
  const sorted = run(destination, ['sort'])
  assert.ok(sorted.count > 0)
  assert.deepEqual(
    existing.map((file) => [file, effectiveDigest(file)]),
    before,
  )
  const after = snapshot(existing)
  const idempotent = await sortEnvFilesFromConfig(undefined, 'all', 'all', { cwd: destination })
  assert.equal(idempotent.changed, false)
  assert.ok(idempotent.results.every((result) => result.conflicts.length === 0))
  assert.deepEqual(snapshot(existing), after)
  run(destination, ['sort', '--check'])
  const count = vaultCycle(destination, files)
  assert.deepEqual(snapshot(tracked), originalBytes)
  process.stdout.write(
    `${path.basename(original)}: ${sorted.count} sorted files, ${sorted.missingCount} missing skipped, ${count} Vault variables; originals unchanged.\n`,
  )
}

async function synthetic() {
  const root = path.join(temporary, 'synthetic')
  mkdirSync(root)
  writeJson(path.join(root, 'package.json'), { name: 'synthetic-downstream' })
  writeJson(path.join(root, 'env-lane.config.json'), {
    workspace: { aliases: { demo: '.' } },
    sort: { default: { targets: ['demo'], suffixes: ['default'] } },
    vault: { enabled: true, configFile: 'smoke-vault.json', disableUnsafeWarning: true },
  })
  const keys = ['AWS_S3', 'AWS_EC2', 'AWS'].flatMap((prefix) =>
    ['A', 'B', 'C'].map((word) => `${prefix}_${word}`),
  )
  const assignments = [
    ...keys.map((key) => `${key}=synthetic-${key}`),
    'DB_HOST=old',
    'DB_PORT=old',
    'DB_USER=old',
    'MULTI="one\n  two" # say "old"',
  ]
  const template = `# original header\n${assignments.join('\n')}\n`
  writeFileSync(path.join(root, '.env.example'), template)
  writeFileSync(
    path.join(root, '.env'),
    `${assignments.slice(0, -1).reverse().join('\n')}\n${assignments.at(-1)}\n`,
  )
  const output = run(root, ['sort'], [0], false)
  for (const prefix of ['AWS_S3', 'AWS_EC2', 'AWS']) assert.ok(output.includes(`${prefix} (3)`))
  const file = path.join(root, '.env')
  const initial = effectiveDigest(file)
  assert.equal(run(root, ['sort']).changed, false)
  applyEnvDocumentPatches(file, [{ op: 'set', key: 'DB_PORT', value: 'personal' }])
  writeFileSync(
    path.join(root, '.env.example'),
    template
      .replace('original header', 'new header')
      .replace('DB_HOST=old', 'DB_HOST=new')
      .replace('DB_PORT=old', 'DB_PORT=new')
      .replace('say "old"', 'say "new"'),
  )
  const state = path.join(root, '.env-lane-cache/sort-sync-state.json')
  const unchanged = snapshot([file, state])
  const check = run(root, ['sort', '--check'], [1])
  assert.equal(check.results[0].conflicts[0].key, 'DB_PORT')
  assert.deepEqual(snapshot([file, state]), unchanged)
  for (let index = 0; index < 2; index++) {
    const result = run(root, ['sort'])
    assert.equal(result.results[0].conflicts.length, 1)
    const values = parseEnvDocument(readFileSync(file, 'utf8')).currentMap
    assert.equal(values.get('DB_HOST').effectiveValue, 'new')
    assert.equal(values.get('DB_PORT').effectiveValue, 'personal')
  }
  applyEnvDocumentPatches(file, [{ op: 'set', key: 'DB_PORT', value: 'new' }])
  assert.equal(run(root, ['sort']).results[0].conflicts.length, 0)
  assert.notEqual(effectiveDigest(file), initial)
  run(root, ['sort', '--check'])
  const empty = path.join(root, 'empty-template')
  writeFileSync(empty, '')
  const missing = path.join(root, 'absent.env')
  assert.equal((await sortEnvFile(missing, empty, { cwd: root })).status, 'missing')
  assert.equal(existsSync(missing), false)
  assert.equal((await sortEnvFile(missing, empty, { cwd: root, create: true })).applied, true)
  assert.equal(readFileSync(missing, 'utf8'), '')
  configureVault(root, [file])
  const count = vaultCycle(root, [file])
  process.stdout.write(
    `Synthetic directory: grouping, cache conflicts, read-only check, empty creation, and ${count} Vault variables passed.\n`,
  )
}

try {
  await synthetic()
  for (const [index, original] of process.argv.slice(2).entries()) await downstream(original, index)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
