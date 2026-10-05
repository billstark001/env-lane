import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = path.resolve(import.meta.dirname, '../..')
const contract = JSON.parse(
  readFileSync(path.join(workspace, 'compat/contracts/v0.4.2.json'), 'utf8'),
)
const classification = JSON.parse(
  readFileSync(path.join(workspace, 'compat/contracts/v0.4.2-test-classification.json'), 'utf8'),
)
const oracleDir = path.join(workspace, 'compat/oracle/v0.4.2')
const oracle = JSON.parse(readFileSync(path.join(oracleDir, 'manifest.json'), 'utf8'))

if (JSON.stringify(contract).includes('TBD')) throw new Error('Contract manifest contains TBD')
assert.equal(contract.baseline.tests.assertions, 229)
assert.equal(classification.total, 229)
assert.equal(classification.tests.length, 229)
assert.equal(
  new Set(classification.tests.map((test) => `${test.file}\0${test.ordinal}\0${test.fullName}`))
    .size,
  229,
)
assert.deepEqual(contract.compatibilityExceptions, [])

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(resolved)
    return entry.isFile() && entry.name.endsWith('.ts') ? [resolved] : []
  })
}

const source = ['core', 'vault', 'cli']
  .flatMap((packageName) => sourceFiles(path.join(workspace, 'packages', packageName, 'src')))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
const implementedErrorCodes = new Set(
  [...source.matchAll(/new EnvLaneError\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)].map((match) => match[1]),
)
for (const code of implementedErrorCodes) {
  assert.ok(contract.errors.includes(code), `error code missing from contract: ${code}`)
}

const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-contract-'))
try {
  const extraction = spawnSync(
    'tar',
    ['-xzf', path.join(oracleDir, oracle.artifact), '-C', temporary],
    { encoding: 'utf8' },
  )
  if (extraction.status !== 0) throw new Error(extraction.stderr)
  const runtime = path.join(temporary, 'runtime')
  const entries = {
    '@env-lane/core': 'node_modules/@env-lane/core/dist/index.js',
    '@env-lane/core/env-document': 'node_modules/@env-lane/core/dist/env-document.js',
    '@env-lane/vault': 'node_modules/@env-lane/vault/dist/index.js',
    '@env-lane/vault/cli': 'node_modules/@env-lane/vault/dist/cli/index.js',
  }
  const require = createRequire(import.meta.url)
  for (const [name, relative] of Object.entries(entries)) {
    const module = await import(pathToFileURL(path.join(runtime, relative)))
    assert.deepEqual(
      Object.keys(module).sort(),
      [...contract.entrypoints[name].runtimeExports].sort(),
      name,
    )
    const commonJsPath = path.join(runtime, relative.replace(/\.js$/, '.cjs'))
    assert.deepEqual(
      Object.keys(require(commonJsPath)).sort(),
      [...contract.entrypoints[name].runtimeExports].sort(),
      `${name} CommonJS`,
    )
    const declarationPath = path.join(runtime, relative.replace(/\.js$/, '.d.ts'))
    assert.ok(existsSync(declarationPath), `${name} types`)
  }
  const facadePath = path.join(runtime, 'node_modules/env-lane/dist/index.js')
  const facade = await import(pathToFileURL(facadePath))
  assert.deepEqual(
    Object.keys(facade).sort(),
    [...contract.entrypoints['@env-lane/core'].runtimeExports].sort(),
    'env-lane ESM facade runtime exports',
  )
  assert.deepEqual(
    Object.keys(require(facadePath.replace(/\.js$/, '.cjs'))).sort(),
    [...contract.entrypoints['@env-lane/core'].runtimeExports].sort(),
    'env-lane CommonJS facade runtime exports',
  )
  const facadeDeclarationPath = facadePath.replace(/\.js$/, '.d.ts')
  assert.ok(existsSync(facadeDeclarationPath), 'env-lane facade types')
  const typeEntrypoints = {
    'env-lane': contract.entrypoints['@env-lane/core'].typeExports,
    '@env-lane/core': contract.entrypoints['@env-lane/core'].typeExports,
    '@env-lane/core/env-document': contract.entrypoints['@env-lane/core/env-document'].typeExports,
    '@env-lane/vault': contract.entrypoints['@env-lane/vault'].typeExports,
    '@env-lane/vault/cli': contract.entrypoints['@env-lane/vault/cli'].typeExports,
  }
  const probePath = path.join(runtime, 'contract-types.ts')
  writeFileSync(
    probePath,
    Object.entries(typeEntrypoints)
      .map(
        ([entrypoint, names], index) =>
          `import type { ${names.map((name) => `${name} as E${index}_${name}`).join(', ')} } from '${entrypoint}'\ntype Contract${index} = [${names.map((name) => `E${index}_${name}`).join(', ')}]\n`,
      )
      .join('\n'),
  )
  const typecheck = spawnSync(
    path.join(workspace, 'node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      probePath,
    ],
    { cwd: runtime, encoding: 'utf8' },
  )
  if (typecheck.status !== 0) {
    throw new Error(`Contract declaration exports failed:\n${typecheck.stdout}${typecheck.stderr}`)
  }

  const help = spawnSync(process.execPath, [path.join(temporary, oracle.entrypoint), '--help'], {
    encoding: 'utf8',
  })
  assert.equal(help.status, 0)
  for (const command of contract.cli.commands.filter((item) => !item.name.includes(' '))) {
    assert.match(help.stdout, new RegExp(`\\b${command.name.replace('-', '\\-')}\\b`))
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

const caseFiles = readdirSync(path.join(workspace, 'compat/fixtures/cases')).filter((file) =>
  file.endsWith('.json'),
)
const ids = new Set()
const coveredCommands = new Set()
const coveredOperations = new Set()
for (const file of caseFiles) {
  const fixture = JSON.parse(
    readFileSync(path.join(workspace, 'compat/fixtures/cases', file), 'utf8'),
  )
  assert.equal(fixture.schemaVersion, 1)
  assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`)
  ids.add(fixture.id)
  assert.ok(
    ['rust-core', 'native-cli', 'node-compat', 'shared-protocol'].includes(fixture.owner),
    `${fixture.id} has unknown owner`,
  )
  assert.ok(
    fixture.steps.every((step) => step.expected),
    `${fixture.id} has unrecorded steps`,
  )
  for (const step of fixture.steps) {
    if (step.kind === 'api') coveredOperations.add(step.operation)
    if (step.kind === 'cli') {
      const command = step.argv.find((argument) => !argument.startsWith('-'))
      if (!command) continue
      const index = step.argv.indexOf(command)
      coveredCommands.add(
        command === 'vault' && step.argv[index + 1] ? `vault ${step.argv[index + 1]}` : command,
      )
    }
  }
}
for (const command of contract.cli.commands) {
  assert.ok(
    coveredCommands.has(command.name),
    `public command lacks shared fixture: ${command.name}`,
  )
  for (const alias of command.aliases ?? []) {
    assert.ok(coveredCommands.has(alias), `public command alias lacks shared fixture: ${alias}`)
  }
}
for (const operation of [
  'core.load-config',
  'core.packages',
  'core.resolve-target',
  'core.files',
  'core.resolve',
  'core.selector-check',
  'core.policy-check',
  'core.sync',
  'core.sort-file',
  'env.parse',
  'env.format',
  'env.patch',
  'vault.load-config',
  'vault.encrypt',
  'vault.plan',
  'vault.decrypt',
]) {
  assert.ok(coveredOperations.has(operation), `stable operation lacks shared fixture: ${operation}`)
}

const momentProjectVault = JSON.parse(
  readFileSync(
    path.join(workspace, 'compat/fixtures/topologies/moment-project/env-lane.vault.json'),
    'utf8',
  ),
)
assert.equal(momentProjectVault.envFiles.length, 23)
const platformBoundaries = JSON.parse(
  readFileSync(path.join(workspace, 'compat/fixtures/dotenv/platform-boundaries.json'), 'utf8'),
)
assert.deepEqual(platformBoundaries.unclassified, [])

process.stdout.write(
  `Verified contract manifest, ${classification.total} classified tests, and ${caseFiles.length} shared fixtures\n`,
)
