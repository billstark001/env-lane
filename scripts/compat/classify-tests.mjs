import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const workspace = path.resolve(import.meta.dirname, '../..')
const outputPath = path.join(workspace, 'compat/contracts/v0.4.2-test-classification.json')
const reportPath = path.join(workspace, '.compat-vitest-report.json')
const write = process.argv.includes('--write')

const result = spawnSync(
  path.join(workspace, 'node_modules/.bin/vitest'),
  [
    'run',
    'packages/cli/test',
    'packages/core/test',
    'packages/vault/test',
    '--reporter=json',
    `--outputFile=${reportPath}`,
  ],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' },
)
if (result.status !== 0) {
  process.stderr.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
rmSync(reportPath)
const safetyPattern =
  /atomic|symbolic|invalid|reject|throw|fail|redact|secret|entropy|jwt|paseto|conflict|stale|corrupt|lock|concurrent|dry-run|without (?:changing|creating|writing)|unreadable|missing|cancel|non-interactive|unsafe|exclude|delete|remap|cross-checkout|another checkout/i
const internalPattern =
  /line AST|closing quotes|normalizeEnvFileVariant|fingerprint|preview|selection and fail-on|prompt|object-style exclude|config files|from config|diagnostic|merged cwd|bootstrap options/i

const tests = [...report.testResults]
  .sort((left, right) => left.name.localeCompare(right.name))
  .flatMap((file) => {
    const relativeFile = path.relative(workspace, file.name).replaceAll(path.sep, '/')
    return file.assertionResults.map((test, ordinal) => {
      const category = safetyPattern.test(test.fullName)
        ? 'safety-regression'
        : internalPattern.test(test.fullName)
          ? 'internal-implementation'
          : 'public-contract'
      return { file: relativeFile, ordinal: ordinal + 1, fullName: test.fullName, category }
    })
  })

const counts = Object.fromEntries(
  ['public-contract', 'internal-implementation', 'safety-regression'].map((category) => [
    category,
    tests.filter((test) => test.category === category).length,
  ]),
)
const classification = {
  schemaVersion: 1,
  baseline: 'env-lane@0.4.2',
  total: tests.length,
  counts,
  tests,
}
const serialized = `${JSON.stringify(classification, null, 2)}\n`

if (tests.length !== 229) throw new Error(`Expected 229 baseline tests, found ${tests.length}`)
if (write) {
  writeFileSync(outputPath, serialized)
  process.stdout.write(`Wrote ${tests.length} classified tests to ${outputPath}\n`)
} else if (readFileSync(outputPath, 'utf8') !== serialized) {
  throw new Error('Test classification is stale. Run pnpm compat:classify -- --write')
} else {
  process.stdout.write(`Verified ${tests.length} classified baseline tests\n`)
}
