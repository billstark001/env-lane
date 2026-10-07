import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { workspace } from './rust-support.mjs'

if (process.platform === 'win32') {
  process.stdout.write('Native run signal and PTY regressions require POSIX.\n')
} else {
  const build = spawnSync('cargo', ['build', '--locked', '-p', 'env-lane-cli'], {
    cwd: workspace,
    encoding: 'utf8',
  })
  assert.equal(build.status, 0, build.stderr)
  const result = spawnSync(
    'python3',
    [
      path.join(workspace, 'scripts/compat/rust-process-signals.py'),
      path.join(workspace, 'target/debug/env-lane'),
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, ENV_LANE_TEST_NODE: process.execPath },
    },
  )
  assert.ifError(result.error)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  assert.equal(result.status, 0, 'Native run signal regressions failed')
}
