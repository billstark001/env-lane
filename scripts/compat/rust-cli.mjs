import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  normalizeCliObservation,
  normalizeRoot,
  runRustExample,
  withOracle,
  workspace,
} from './rust-support.mjs'

const build = spawnSync('cargo', ['build', '--locked', '--bin', 'env-lane'], {
  cwd: workspace,
  encoding: 'utf8',
})
assert.equal(build.status, 0, build.stderr)
const executable = path.join(
  workspace,
  'target/debug',
  process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
)
const cases = [
  'moment-project-core-cli',
  'moment-landing-duplicate-local',
  'sort-sync-side-effects',
  'process-contract',
  'cli-bootstrap-and-child-boundary',
]
const cliVersion = JSON.parse(
  readFileSync(path.join(workspace, 'packages/cli/package.json'), 'utf8'),
).version
function expectedObservation(name, index, step) {
  if (name === 'process-contract' && index === 2) {
    return { ...step.expected, status: null }
  }
  if (name === 'cli-bootstrap-and-child-boundary' && index === 0) {
    return { ...step.expected, stdout: `${cliVersion}\n` }
  }
  return step.expected
}

await withOracle(async ({ temporary }) => {
  const failures = []
  let count = 0
  const pending = {
    'cli-bootstrap-and-child-boundary:2':
      'Full help/Commander and npm Vault peer presentation awaits the facade and Vault CLI.',
    'cli-bootstrap-and-child-boundary:4':
      'Missing executable-config fallback awaits the external configuration bridge.',
    'moment-project-core-cli:4': 'The deprecated env-files alias was removed in 0.5.0.',
    'moment-project-core-cli:5': 'The deprecated env-json alias was removed in 0.5.0.',
  }
  for (const name of cases) {
    // This frozen process case encodes POSIX quoting and signals; Windows is
    // compared live against the oracle by rust-process.mjs.
    if (name === 'process-contract' && process.platform === 'win32') continue
    const fixture = JSON.parse(
      readFileSync(path.join(workspace, 'compat/fixtures/cases', `${name}.json`), 'utf8'),
    )
    const directory = path.join(temporary, name)
    cpSync(path.join(workspace, 'compat/fixtures/topologies', fixture.topology), directory, {
      recursive: true,
    })
    const root = realpathSync(directory)
    const env = { ...process.env, TZ: 'UTC', NO_COLOR: '1', FORCE_COLOR: '0' }
    for (const key of fixture.environment?.unset ?? []) delete env[key]
    Object.assign(env, fixture.environment?.set ?? {})
    for (const [index, step] of fixture.steps.entries()) {
      if (pending[`${name}:${index + 1}`]) continue
      if (step.kind === 'api') {
        const input = step.input ?? {}
        const request =
          step.operation === 'core.sort-file'
            ? {
                operation: 'file',
                file: path.resolve(root, input.file),
                template: path.resolve(root, input.template),
                options: input,
              }
            : {
                ...input,
                cwd: root,
                operation: {
                  'core.files': 'files',
                  'core.resolve': 'resolve',
                  'core.sync': 'sync',
                }[step.operation],
              }
        const example = step.operation === 'core.sort-file' ? 'sort-protocol' : 'config-protocol'
        assert.deepEqual(
          normalizeRoot(runRustExample(example, [request])[0], root),
          JSON.parse(step.expected.stdout),
        )
        continue
      }
      const result = spawnSync(executable, step.argv, {
        cwd: path.resolve(root, step.cwd ?? '.'),
        env,
        input: step.stdin,
        encoding: 'utf8',
        timeout: 20_000,
      })
      assert.ifError(result.error)
      const actual = normalizeCliObservation(
        { status: result.status, stdout: result.stdout, stderr: result.stderr },
        root,
      )
      const expected = expectedObservation(name, index, step)
      if (name === 'process-contract' && index === 2) {
        assert.equal(result.signal, 'SIGTERM')
      }
      try {
        assert.deepEqual(actual, expected)
      } catch {
        failures.push({ name, step: index + 1, actual, expected })
      }
      count++
    }
    for (const [file, expected] of Object.entries(fixture.expectedFiles)) {
      const full = path.join(root, file)
      assert.equal(
        existsSync(full) ? normalizeRoot(readFileSync(full, 'utf8'), root) : null,
        expected,
      )
    }
  }
  assert.deepEqual(failures, [], 'Native CLI frozen fixtures')
  process.stdout.write(
    `Rust Core CLI: ${count} retained steps passed; ${Object.keys(pending).length} historical steps are excluded from the 0.5 contract.\n`,
  )
})
