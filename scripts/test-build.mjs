import { spawnSync } from 'node:child_process'
import { accessSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(import.meta.dirname, '..')
const packages = ['core', 'vault', 'cli']

for (const packageName of packages) {
  const distDir = path.join(rootDir, 'packages', packageName, 'dist')
  for (const artifact of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']) {
    accessSync(path.join(distDir, artifact))
  }
  await import(pathToFileURL(path.join(distDir, 'index.js')).href)
  createRequire(import.meta.url)(path.join(distDir, 'index.cjs'))
}

const cliPath = path.join(rootDir, 'packages', 'cli', 'dist', 'cli.js')
accessSync(cliPath)

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

  writeFileSync(path.join(runFixture, 'key.aes'), 'dev-only-key-material')
  writeFileSync(path.join(runFixture, '.env'), 'A=vault\n')
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
  writeFileSync(path.join(runFixture, '.env'), 'A=local\n')
  const failOnChange = spawnSync(
    process.execPath,
    [cliPath, 'vault', 'plan', 'key.aes', '--cwd', runFixture, '--json', '--fail-on', 'change'],
    { encoding: 'utf8' },
  )
  if (failOnChange.status !== 2 || JSON.parse(failOnChange.stdout).summary.modify !== 1) {
    throw new Error('Built Vault CLI --fail-on change must return the documented exit code 2.')
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
} finally {
  rmSync(runFixture, { recursive: true, force: true })
}
