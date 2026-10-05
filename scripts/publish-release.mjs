import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NATIVE_TARGETS } from './native-targets.mjs'

const root = path.resolve(import.meta.dirname, '..')
if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
  throw new Error('Publishing requires GitHub Actions OIDC from release.yml.')
}
if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
  throw new Error('Remove npm publish tokens; this release uses trusted publishing.')
}
const [npmMajor, npmMinor, npmPatch] = process.versions.npm
  ? process.versions.npm.split('.').map(Number)
  : spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8' })
      .stdout.trim()
      .split('.')
      .map(Number)
if (npmMajor < 11 || (npmMajor === 11 && (npmMinor < 5 || (npmMinor === 5 && npmPatch < 1)))) {
  throw new Error('Trusted publishing requires npm >= 11.5.1.')
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

function publishDirectory(directory) {
  run('npm', ['publish', directory, '--access', 'public', '--provenance', '--ignore-scripts'])
}

function publishWorkspace(name) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-release-pack-'))
  try {
    run('pnpm', ['--filter', name, 'pack', '--pack-destination', temporary])
    const archives = readdirSync(temporary).filter((entry) => entry.endsWith('.tgz'))
    if (archives.length !== 1) throw new Error(`Expected one package archive for ${name}.`)
    publishDirectory(path.join(temporary, archives[0]))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

run('node', ['scripts/verify-native-packages.mjs'])
const platformRoot = path.join(root, 'packages/native/npm')
for (const entry of Object.values(NATIVE_TARGETS).sort()) {
  publishDirectory(path.join(platformRoot, entry))
}
const vaultPlatformRoot = path.join(root, 'packages/vault/npm')
for (const entry of Object.values(NATIVE_TARGETS).sort()) {
  publishDirectory(path.join(vaultPlatformRoot, entry))
}
publishDirectory('./packages/native')
for (const name of [
  '@env-lane/plugin-sdk',
  '@env-lane/config-compat',
  '@env-lane/core',
  '@env-lane/vault',
  'env-lane',
]) {
  publishWorkspace(name)
}
