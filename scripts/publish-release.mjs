import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const root = path.resolve(import.meta.dirname, '..')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

run('node', ['scripts/verify-native-packages.mjs'])
const platformRoot = path.join(root, 'packages/native/npm')
for (const entry of Object.values(NATIVE_TARGETS).sort()) {
  run('npm', [
    'publish',
    path.join(platformRoot, entry),
    '--access',
    'public',
    '--provenance',
    '--ignore-scripts',
  ])
}
const vaultPlatformRoot = path.join(root, 'packages/vault/npm')
for (const entry of Object.values(NATIVE_TARGETS).sort()) {
  run('npm', [
    'publish',
    path.join(vaultPlatformRoot, entry),
    '--access',
    'public',
    '--provenance',
    '--ignore-scripts',
  ])
}
run('npm', [
  'publish',
  './packages/native',
  '--access',
  'public',
  '--provenance',
  '--ignore-scripts',
])
for (const name of [
  '@env-lane/plugin-sdk',
  '@env-lane/config-compat',
  '@env-lane/core',
  '@env-lane/vault',
  'env-lane',
]) {
  run('pnpm', ['--filter', name, 'publish', '--access', 'public', '--no-git-checks'])
}
