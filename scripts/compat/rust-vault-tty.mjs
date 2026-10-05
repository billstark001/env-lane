import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { workspace } from './rust-support.mjs'

if (process.platform === 'win32') {
  process.stdout.write(
    'Native Vault PTY test requires POSIX; Windows non-interactive gates run separately.\n',
  )
} else {
  const build = spawnSync(
    'cargo',
    ['build', '--locked', '--bin', 'env-lane', '--bin', 'env-lane-plugin-vault'],
    {
      cwd: workspace,
      encoding: 'utf8',
    },
  )
  assert.equal(build.status, 0, build.stderr)
  const staged = spawnSync(process.execPath, ['scripts/stage-local-plugins.mjs'], {
    cwd: workspace,
    encoding: 'utf8',
  })
  assert.equal(staged.status, 0, staged.stderr)
  const result = spawnSync(
    'python3',
    [
      path.join(workspace, 'scripts/compat/rust-vault-tty.py'),
      path.join(workspace, 'target/debug/env-lane'),
    ],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        ENV_LANE_PLUGIN_PACKAGE_ROOT: path.join(workspace, 'target/debug'),
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  process.stdout.write(result.stdout)
}
