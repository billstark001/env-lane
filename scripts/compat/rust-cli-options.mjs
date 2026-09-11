import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeCliObservation, withOracle, workspace } from './rust-support.mjs'

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

function observe(program, args, root, env = process.env) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.ifError(result.error)
  return normalizeCliObservation(
    { status: result.status, stdout: result.stdout, stderr: result.stderr },
    root,
  )
}

await withOracle(async ({ temporary, runtime }) => {
  const directory = path.join(temporary, 'project')
  cpSync(path.join(workspace, 'compat/fixtures/topologies/moment-landing'), directory, {
    recursive: true,
  })
  const root = realpathSync(directory)
  const oracle = path.join(runtime, 'node_modules/env-lane/dist/cli.js')
  const common = ['--config', 'env-lane.config.json']
  const cases = [
    ['packages', '--json'],
    ['packages', '--format', 'dotenv'],
    ['packages', '--format', 'invalid'],
    ['packages', '--unexpected', '--json'],
    ['files', 'missing', '--json'],
    ['files', 'landing', '--no-prefix', '--build', 'unknown'],
    ['run', 'landing', '--quiet', '--json', 'node', 'child-cwd.mjs'],
    ['run', 'landing', '--quiet'],
    ['resolve-target'],
    ['print'],
    ['print', 'landing'],
    ['print', 'landing', '--format', 'dotenv'],
    ['print', 'landing', '--json', '--no-process-env'],
    ['check', '--json'],
    ['check', '--target', 'all', '--policy', 'example', '--json'],
    ['check', '--target', 'all', '--format', 'dotenv'],
    ['sync', 'missing', '--dry-run', '--json'],
    ['sync', 'missing', '--format', 'dotenv'],
    ['sort-file', '.env', '.env.example', '--check', '--eol', 'invalid', '--json'],
    ['not-a-command', '--json'],
    ['--json', 'packages', '--format', 'text'],
  ]
  // The missing config '--json' positional-value case belongs to the pending
  // executable-config fallback gate, alongside missing.config.ts.
  const failures = []
  for (const args of cases) {
    const actual = observe(executable, [...common, ...args], root)
    const expected = observe(process.execPath, [oracle, ...common, ...args], root)
    try {
      assert.deepEqual(actual, expected)
    } catch {
      failures.push({ args, actual, expected })
    }
  }
  writeFileSync(
    path.join(root, 'json-default.json'),
    JSON.stringify({ output: { format: 'json', prefix: false } }),
  )
  for (const config of ['env-lane.config.json', 'json-default.json']) {
    const args = ['--config', config, 'packages', '--unexpected']
    assert.deepEqual(
      observe(executable, args, root),
      observe(process.execPath, [oracle, ...args], root),
    )
  }
  const noNode = observe(executable, [...common, 'packages', '--json'], root, {
    ...process.env,
    PATH: '',
  })
  assert.equal(noNode.status, 0)
  assert.equal(JSON.parse(noNode.stdout).length, 2)
  assert.deepEqual(failures, [], 'CLI option and failure differential')
  process.stdout.write(`Rust CLI options: ${cases.length + 2} cases and no-Node smoke passed.\n`)
})
