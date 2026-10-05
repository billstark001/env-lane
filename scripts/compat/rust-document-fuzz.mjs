import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { withOracle, workspace } from './rust-support.mjs'

await withOracle(({ temporary, runtime }) => {
  const result = spawnSync(
    'cargo',
    ['test', '--locked', '--test', 'document_differential', '--', '--ignored'],
    {
      cwd: workspace,
      env: {
        ...process.env,
        ENV_LANE_TEST_NODE: process.execPath,
        ENV_LANE_ORACLE_DOCUMENT: path.join(
          runtime,
          'node_modules/@env-lane/core/dist/env-document.js',
        ),
        ENV_LANE_ORACLE_TEMP: temporary,
      },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  )
  process.stdout.write(result.stdout)
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})
