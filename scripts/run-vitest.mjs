import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ENV_LANE_PLUGIN_PACKAGE_ROOT: path.join(root, 'target/debug') },
  },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
