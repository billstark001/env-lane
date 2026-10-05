import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { workspace } from './rust-support.mjs'

const require = createRequire(import.meta.url)
const { platformSuffix } = require('../../packages/native/bin.cjs')

const build = spawnSync(
  'cargo',
  ['build', '--locked', '--bin', 'env-lane', '--bin', 'env-lane-plugin-vault'],
  {
    cwd: workspace,
    encoding: 'utf8',
  },
)
assert.equal(build.status, 0, build.stderr)
const binary = path.join(
  workspace,
  'target/debug',
  process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
)
const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-native-install-'))
const modules = path.join(temporary, 'node_modules')
const installed = path.join(modules, 'env-lane')
const scope = path.join(modules, '@env-lane')
const vault = path.join(scope, 'vault')
const currentVersion = JSON.parse(
  readFileSync(path.join(workspace, 'packages/cli/package.json'), 'utf8'),
).version
try {
  writeFileSync(path.join(temporary, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n")
  mkdirSync(path.join(installed, 'scripts'), { recursive: true })
  mkdirSync(scope, { recursive: true })
  copyFileSync(
    path.join(workspace, 'packages/cli/scripts/install-native.cjs'),
    path.join(installed, 'scripts/install-native.cjs'),
  )
  symlinkSync(
    path.join(workspace, 'packages/native'),
    path.join(scope, 'native'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const install = () => {
    const result = spawnSync(process.execPath, ['scripts/install-native.cjs'], {
      cwd: installed,
      encoding: 'utf8',
      env: { ...process.env, ENV_LANE_NATIVE_BINARY: binary },
    })
    assert.equal(result.status, 0, result.stderr)
  }
  const invoke = () => {
    const executable = path.join(
      installed,
      'dist',
      process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
    )
    const binDirectory = path.join(modules, '.bin')
    const linked = path.join(binDirectory, 'env-lane')
    if (process.platform !== 'win32' && !existsSync(linked)) {
      mkdirSync(binDirectory, { recursive: true })
      symlinkSync(executable, linked)
    }
    const result = spawnSync(
      process.platform === 'win32' ? executable : linked,
      ['--json', 'vault', 'plan', 'missing-key'],
      {
        cwd: temporary,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
      },
    )
    return JSON.parse(result.stdout)
  }
  install()
  assert.equal(invoke().error.code, 'VAULT_NOT_INSTALLED')
  mkdirSync(vault, { recursive: true })
  writeFileSync(path.join(vault, 'index.js'), '')
  const version = (value) =>
    writeFileSync(
      path.join(vault, 'package.json'),
      JSON.stringify({ name: '@env-lane/vault', version: value, main: 'index.js' }),
    )
  version('0.3.0')
  assert.equal(invoke().error.code, 'VAULT_VERSION_UNSUPPORTED')
  version(currentVersion)
  const pluginName =
    process.platform === 'win32' ? 'env-lane-plugin-vault.exe' : 'env-lane-plugin-vault'
  const platformPackage = path.join(scope, `vault-native-${platformSuffix()}`)
  mkdirSync(platformPackage, { recursive: true })
  writeFileSync(
    path.join(platformPackage, 'package.json'),
    JSON.stringify({
      name: `@env-lane/vault-native-${platformSuffix()}`,
      main: pluginName,
    }),
  )
  copyFileSync(
    path.join(workspace, 'target/debug', pluginName),
    path.join(platformPackage, pluginName),
  )
  mkdirSync(path.join(vault, 'scripts'), { recursive: true })
  copyFileSync(
    path.join(workspace, 'packages/vault/scripts/install-native.cjs'),
    path.join(vault, 'scripts/install-native.cjs'),
  )
  const vaultInstall = spawnSync(process.execPath, ['scripts/install-native.cjs'], {
    cwd: vault,
    encoding: 'utf8',
  })
  assert.equal(vaultInstall.status, 0, vaultInstall.stderr)
  assert.ok(existsSync(path.join(vault, 'dist', pluginName)))
  assert.notEqual(invoke().error.code, 'VAULT_NOT_INSTALLED')
  assert.notEqual(invoke().error.code, 'VAULT_VERSION_UNSUPPORTED')
  process.stdout.write(
    'Native npm install simulation: direct executable and Vault peer gates passed.\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
