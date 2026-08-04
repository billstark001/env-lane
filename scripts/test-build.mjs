import { spawnSync } from 'node:child_process'
import { accessSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(import.meta.dirname, '..')
const packages = ['core', 'vault', 'cli']
const packageEntries = {
  core: ['index', 'env-document'],
  vault: ['index', 'cli/index'],
  cli: ['index'],
}
const builtModules = new Map()

function assertExports(label, module, names) {
  const missing = names.filter((name) => !(name in module))
  if (missing.length > 0) {
    throw new Error(`${label} is missing public export(s): ${missing.join(', ')}`)
  }
}

for (const packageName of packages) {
  const distDir = path.join(rootDir, 'packages', packageName, 'dist')
  for (const entry of packageEntries[packageName]) {
    for (const extension of ['js', 'cjs', 'd.ts']) {
      accessSync(path.join(distDir, `${entry}.${extension}`))
    }
    const esm = await import(pathToFileURL(path.join(distDir, `${entry}.js`)).href)
    const cjs = createRequire(import.meta.url)(path.join(distDir, `${entry}.cjs`))
    builtModules.set(`${packageName}:${entry}:esm`, esm)
    builtModules.set(`${packageName}:${entry}:cjs`, cjs)
  }
}

for (const format of ['esm', 'cjs']) {
  assertExports(`@env-lane/core (${format})`, builtModules.get(`core:index:${format}`), [
    'DEFAULT_MIN_REDACTION_LENGTH',
    'checkDotenvSelector',
    'defineConfig',
    'isHighEntropyString',
    'isJwt',
    'isPaseto',
    'listEnvFiles',
    'listWorkspacePackages',
    'resolveInjectedEnv',
    'runEnvCheck',
    'runEnvSync',
    'runWithInjectedEnv',
    'sortEnvFile',
    'sortEnvFilesFromConfig',
    'withEnvLaneContext',
  ])
  assertExports(
    `@env-lane/core/env-document (${format})`,
    builtModules.get(`core:env-document:${format}`),
    [
      // biome-ignore lint/security/noSecrets: Public API symbol name, not a credential.
      'applyEnvDocumentPatches',
      'formatEnvValue',
      'loadEnvDocument',
      'parseEnvDocument',
      'parseEnvLine',
    ],
  )
  assertExports(`@env-lane/vault (${format})`, builtModules.get(`vault:index:${format}`), [
    'applyRestorePlan',
    'buildRestorePlan',
    'defineVaultConfig',
    'decryptEnvFiles',
    'encryptEnvFiles',
    'loadVaultConfig',
    'pruneVaultHistory',
    'sanitizeVaultHistory',
  ])
  assertExports(`@env-lane/vault/cli (${format})`, builtModules.get(`vault:cli/index:${format}`), [
    'registerVaultCommands',
  ])
  assertExports(`env-lane facade (${format})`, builtModules.get(`cli:index:${format}`), [
    'defineConfig',
    'resolveInjectedEnv',
    'runEnvCheck',
    'sortEnvFile',
  ])

  if ('resolveInjectedEnv' in builtModules.get(`core:env-document:${format}`)) {
    throw new Error('@env-lane/core/env-document must not expose high-level Core use cases.')
  }
  if ('encryptEnvFiles' in builtModules.get(`vault:cli/index:${format}`)) {
    throw new Error('@env-lane/vault/cli must not expose Vault automation use cases.')
  }
}

const corePackageRequire = createRequire(path.join(rootDir, 'packages', 'core', 'package.json'))
const vaultPackageRequire = createRequire(path.join(rootDir, 'packages', 'vault', 'package.json'))
assertExports(
  '@env-lane/core/env-document package export (cjs)',
  corePackageRequire('@env-lane/core/env-document'),
  ['parseEnvDocument'],
)
assertExports(
  '@env-lane/vault/cli package export (cjs)',
  vaultPackageRequire('@env-lane/vault/cli'),
  ['registerVaultCommands'],
)

const cliPath = path.join(rootDir, 'packages', 'cli', 'dist', 'cli.js')
accessSync(cliPath)

const defaultHelp = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' })
if (
  defaultHelp.status !== 0 ||
  !defaultHelp.stdout.startsWith('Usage: env-lane [options] [command]') ||
  !defaultHelp.stdout.includes('Commands:') ||
  defaultHelp.stderr !== ''
) {
  throw new Error('Invoking the built CLI without arguments must print help and exit successfully.')
}

const jsonError = spawnSync(
  process.execPath,
  [cliPath, 'vault', 'apply', 'missing-key', '--json'],
  { encoding: 'utf8' },
)
if (jsonError.status !== 1) throw new Error('CLI argument errors must exit with status 1.')
const errorDocument = JSON.parse(jsonError.stdout)
if (errorDocument?.error?.code !== 'CLI_ARGUMENT_ERROR') {
  throw new Error('CLI argument errors must produce one structured JSON document on stdout.')
}

const runFixture = mkdtempSync(path.join(tmpdir(), 'env-lane-built-cli-run-'))
try {
  const markerPath = path.join(runFixture, 'child-arguments.json')
  const childPath = path.join(runFixture, 'capture-args.mjs')
  const childArguments = [
    '--json',
    '--config',
    'child.config.json',
    '--format',
    'child-format',
    '--help',
    '--quiet',
  ]
  writeFileSync(path.join(runFixture, 'package.json'), JSON.stringify({ name: 'run-fixture' }))
  writeFileSync(
    childPath,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  )

  for (const boundary of [[], ['--']]) {
    const runResult = spawnSync(
      process.execPath,
      [
        cliPath,
        'run',
        '--cwd',
        runFixture,
        '.',
        '--quiet',
        ...boundary,
        process.execPath,
        childPath,
        ...childArguments,
      ],
      { encoding: 'utf8' },
    )
    if (runResult.status !== 0) {
      throw new Error(`Built CLI run pass-through failed: ${runResult.stderr}`)
    }
    const capturedArguments = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (JSON.stringify(capturedArguments) !== JSON.stringify(childArguments)) {
      throw new Error('Built CLI run must pass conflicting child options through unchanged.')
    }
  }

  const missingChild = spawnSync(
    process.execPath,
    [cliPath, 'run', '.', '--cwd', runFixture, '--quiet', '--', 'missing-env-lane-child', '--json'],
    { encoding: 'utf8' },
  )
  if (missingChild.status !== 1 || missingChild.stdout !== '') {
    throw new Error('Child --json must not switch env-lane run failures to JSON output.')
  }

  writeFileSync(
    path.join(runFixture, 'env-lane.config.json'),
    JSON.stringify({
      output: { format: 'json', prefix: false },
    }),
  )
  const configuredError = spawnSync(
    process.execPath,
    [cliPath, 'unknown-command', '--cwd', runFixture],
    { encoding: 'utf8' },
  )
  if (
    configuredError.status !== 1 ||
    JSON.parse(configuredError.stdout).error?.code !== 'CLI_ARGUMENT_ERROR'
  ) {
    throw new Error('Configured JSON output must apply to Commander argument errors.')
  }
  const unprefixedError = spawnSync(
    process.execPath,
    [cliPath, 'unknown-command', '--cwd', runFixture, '--format', 'text'],
    { encoding: 'utf8' },
  )
  if (unprefixedError.status !== 1 || unprefixedError.stderr.includes('[env-lane]')) {
    throw new Error('Configured diagnostic prefix settings must apply to argument errors.')
  }
  writeFileSync(path.join(runFixture, 'broken.config.json'), '{')
  const explicitJsonWithBrokenConfig = spawnSync(
    process.execPath,
    [cliPath, 'unknown-command', '--config', 'broken.config.json', '--cwd', runFixture, '--json'],
    { encoding: 'utf8' },
  )
  if (
    explicitJsonWithBrokenConfig.status !== 1 ||
    JSON.parse(explicitJsonWithBrokenConfig.stdout).error?.code !== 'CLI_ARGUMENT_ERROR'
  ) {
    throw new Error('Explicit --json must survive bootstrap configuration failures.')
  }
  const explicitPrefixWithBrokenConfig = spawnSync(
    process.execPath,
    [
      cliPath,
      'unknown-command',
      '--config',
      'broken.config.json',
      '--cwd',
      runFixture,
      '--no-prefix',
    ],
    { encoding: 'utf8' },
  )
  if (
    explicitPrefixWithBrokenConfig.status !== 1 ||
    explicitPrefixWithBrokenConfig.stderr.includes('[env-lane]')
  ) {
    throw new Error('Explicit --no-prefix must survive bootstrap configuration failures.')
  }
  const stableCoreError = spawnSync(
    process.execPath,
    [cliPath, 'print', '.', '--cwd', runFixture, '--build', 'invalid/build', '--json'],
    { encoding: 'utf8' },
  )
  if (
    stableCoreError.status !== 1 ||
    JSON.parse(stableCoreError.stdout).error?.code !== 'INVALID_BUILD'
  ) {
    throw new Error('Expected core CLI failures must expose stable JSON error codes.')
  }
  const stableConfigError = spawnSync(
    process.execPath,
    [cliPath, 'print', '.', '--cwd', runFixture, '--config', 'broken.config.json', '--json'],
    { encoding: 'utf8' },
  )
  if (
    stableConfigError.status !== 1 ||
    JSON.parse(stableConfigError.stdout).error?.code !== 'CONFIG_LOAD_FAILED'
  ) {
    throw new Error('Config load failures must expose a stable JSON error code.')
  }
  writeFileSync(path.join(runFixture, 'key.aes'), 'dev-only-key-material')
  const secretValue = ['super', 'secret', 'value'].join('-')
  writeFileSync(path.join(runFixture, '.env'), `A=vault\nSECRET_TOKEN=${secretValue}\n`)
  const redactedPrint = spawnSync(
    process.execPath,
    [cliPath, 'print', '.', '--cwd', runFixture, '--json'],
    { encoding: 'utf8' },
  )
  const visiblePrint = spawnSync(
    process.execPath,
    [cliPath, 'print', '.', '--cwd', runFixture, '--json', '--show-secrets'],
    { encoding: 'utf8' },
  )
  if (
    redactedPrint.status !== 0 ||
    JSON.parse(redactedPrint.stdout).SECRET_TOKEN?.value !== '<redacted>' ||
    visiblePrint.status !== 0 ||
    JSON.parse(visiblePrint.stdout).SECRET_TOKEN?.value !== secretValue
  ) {
    throw new Error('Built CLI print must redact secrets unless --show-secrets is explicit.')
  }
  writeFileSync(
    path.join(runFixture, 'env-lane.vault.json'),
    JSON.stringify({
      envFiles: ['.env'],
      outputDir: '.vault',
      outputFile: 'store.dat',
      disableUnsafeWarning: true,
    }),
  )
  const encryptResult = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'encrypt', 'key.aes', '--cwd', runFixture, '--json'],
    { encoding: 'utf8' },
  )
  if (encryptResult.status !== 0) {
    throw new Error(`Built Vault CLI --cwd resolution failed: ${encryptResult.stderr}`)
  }
  writeFileSync(path.join(runFixture, '.env'), `A=local\nSECRET_TOKEN=${secretValue}\n`)
  const failOnChange = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'plan', 'key.aes', '--cwd', runFixture, '--json', '--fail-on', 'change'],
    { encoding: 'utf8' },
  )
  if (failOnChange.status !== 2 || JSON.parse(failOnChange.stdout).summary.modify !== 1) {
    throw new Error('Built Vault CLI --fail-on change must return the documented exit code 2.')
  }
  for (const command of [
    ['plan', '--key', 'OTHER_*'],
    ['decrypt', '--dry-run', '--key', 'OTHER_*'],
  ]) {
    const selectedPlan = spawnSync(
      process.execPath,
      [
        cliPath,
        'vault',
        command[0],
        'key.aes',
        '--cwd',
        runFixture,
        '--json',
        ...command.slice(1),
        '--fail-on',
        'change',
      ],
      { encoding: 'utf8' },
    )
    const selectedDocument = JSON.parse(selectedPlan.stdout)
    if (
      selectedPlan.status !== 0 ||
      selectedDocument.summary.modify !== 0 ||
      selectedDocument.files.length !== 0
    ) {
      throw new Error('Vault plan selection must filter displayed entries and --fail-on results.')
    }
  }
  for (const selection of [
    { args: ['--file', '**/.env'], expectedModify: 1, expectedStatus: 2 },
    { args: ['--include', '**/.env:A'], expectedModify: 1, expectedStatus: 2 },
    { args: ['--exclude', '**/.env:A'], expectedModify: 0, expectedStatus: 0 },
    { args: ['--only', 'add'], expectedModify: 0, expectedStatus: 0 },
    { args: ['--only', 'modify'], expectedModify: 1, expectedStatus: 2 },
  ]) {
    const selectedPlan = spawnSync(
      process.execPath,
      [
        cliPath,
        'vault',
        'plan',
        'key.aes',
        '--cwd',
        runFixture,
        '--json',
        ...selection.args,
        '--fail-on',
        'change',
      ],
      { encoding: 'utf8' },
    )
    if (
      selectedPlan.status !== selection.expectedStatus ||
      JSON.parse(selectedPlan.stdout).summary.modify !== selection.expectedModify
    ) {
      throw new Error(`Built Vault CLI selection failed for ${selection.args.join(' ')}.`)
    }
  }
  const filteredDecrypt = spawnSync(
    process.execPath,
    [
      cliPath,
      'vault',
      'decrypt',
      'key.aes',
      '--cwd',
      runFixture,
      '--json',
      '--yes',
      '--key',
      'OTHER_*',
      '--fail-on',
      'change',
    ],
    { encoding: 'utf8' },
  )
  if (filteredDecrypt.status !== 0 || JSON.parse(filteredDecrypt.stdout).appliedEntries !== 0) {
    throw new Error('Non-dry-run Vault fail-on must use the entries selected for apply.')
  }
  const approvalPath = path.join(runFixture, 'selected-plan.json')
  const selectedApproval = spawnSync(
    process.execPath,
    [
      cliPath,
      'vault',
      'plan',
      'key.aes',
      '--cwd',
      runFixture,
      '--json',
      '--key',
      'OTHER_*',
      '--output',
      approvalPath,
    ],
    { encoding: 'utf8' },
  )
  const approvalDocument = JSON.parse(readFileSync(approvalPath, 'utf8'))
  if (
    selectedApproval.status !== 0 ||
    approvalDocument.plan.summary.modify !== 1 ||
    approvalDocument.decisions.some((decision) => decision.decision !== 'skip')
  ) {
    throw new Error(
      'Filtered approval plans must retain full context with unselected entries skipped.',
    )
  }
  approvalDocument.plan.summary.filesWithChanges = 99
  approvalDocument.plan.summary.modify = 99
  writeFileSync(approvalPath, `${JSON.stringify(approvalDocument, null, 2)}\n`)
  const tamperedSummaryApply = spawnSync(
    process.execPath,
    [
      cliPath,
      'vault',
      'apply',
      'key.aes',
      '--cwd',
      runFixture,
      '--json',
      '--plan',
      approvalPath,
      '--yes',
      '--fail-on',
      'change',
    ],
    { encoding: 'utf8' },
  )
  if (
    tamperedSummaryApply.status !== 0 ||
    JSON.parse(tamperedSummaryApply.stdout).appliedEntries !== 0
  ) {
    throw new Error('Vault apply fail-on must ignore editable approval summary fields.')
  }
  const invalidFailOn = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'plan', 'key.aes', '--cwd', runFixture, '--json', '--fail-on', 'invalid'],
    { encoding: 'utf8' },
  )
  const invalidFailOnDocument = JSON.parse(invalidFailOn.stdout)
  if (invalidFailOn.status !== 1 || invalidFailOnDocument.error?.code !== 'VAULT_INVALID_FAIL_ON') {
    throw new Error('Invalid --fail-on must produce one structured JSON error and exit 1.')
  }

  const conflictFixture = path.join(runFixture, 'conflict-fixture')
  mkdirSync(conflictFixture)
  writeFileSync(path.join(conflictFixture, 'package.json'), JSON.stringify({ name: 'conflict' }))
  writeFileSync(path.join(conflictFixture, 'key.aes'), 'dev-only-key-material')
  writeFileSync(path.join(conflictFixture, '.env'), 'A=baseline\n')
  writeFileSync(
    path.join(conflictFixture, 'env-lane.vault.json'),
    JSON.stringify({
      envFiles: ['.env'],
      outputDir: '.vault',
      outputFile: 'store.dat',
      disableUnsafeWarning: true,
    }),
  )
  const runConflictVault = (args) =>
    spawnSync(process.execPath, [cliPath, 'vault', ...args, '--cwd', conflictFixture, '--json'], {
      encoding: 'utf8',
    })
  if (runConflictVault(['encrypt', 'key.aes', '--sync-dir', '.sync']).status !== 0) {
    throw new Error('Failed to establish the built CLI conflict baseline.')
  }
  writeFileSync(path.join(conflictFixture, '.env'), 'A=vault-change\n')
  if (runConflictVault(['encrypt', 'key.aes']).status !== 0) {
    throw new Error('Failed to prepare the built CLI Vault-side conflict change.')
  }
  writeFileSync(path.join(conflictFixture, '.env'), 'A=local-change\n')
  const failOnConflict = runConflictVault([
    'plan',
    'key.aes',
    '--sync-dir',
    '.sync',
    '--fail-on',
    'conflict',
  ])
  if (failOnConflict.status !== 2 || JSON.parse(failOnConflict.stdout).summary.conflict !== 1) {
    throw new Error('Built Vault CLI --fail-on conflict must return exit code 2.')
  }

  writeFileSync(path.join(runFixture, '.env'), 'A=warning\nthis is not dotenv\n')
  const failOnWarning = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'encrypt', 'key.aes', '--cwd', runFixture, '--json', '--fail-on', 'warning'],
    { encoding: 'utf8' },
  )
  if (failOnWarning.status !== 2 || JSON.parse(failOnWarning.stdout).invalidLinesIgnored !== 1) {
    throw new Error('Built Vault CLI --fail-on warning must return exit code 2.')
  }

  writeFileSync(path.join(runFixture, '.env'), '')
  const blockedDelete = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'encrypt', 'key.aes', '--cwd', runFixture, '--json'],
    { encoding: 'utf8' },
  )
  const approvedDelete = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'encrypt', 'key.aes', '--cwd', runFixture, '--json', '--approve-deletes'],
    { encoding: 'utf8' },
  )
  if (
    blockedDelete.status !== 0 ||
    JSON.parse(blockedDelete.stdout).deleteRecordsWritten !== 0 ||
    approvedDelete.status !== 0 ||
    JSON.parse(approvedDelete.stdout).deleteRecordsWritten === 0
  ) {
    throw new Error('Built Vault CLI deletes must require --approve-deletes.')
  }
} finally {
  rmSync(runFixture, { recursive: true, force: true })
}
