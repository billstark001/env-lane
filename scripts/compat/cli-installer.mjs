import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { platformSuffix } = require('../../packages/native/bin.cjs')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const binaryName = process.platform === 'win32' ? 'env-lane.exe' : 'env-lane'
const source = path.join(root, 'target/debug', binaryName)
assert.ok(existsSync(source), 'Build the native CLI before running the installer test.')

const fixture = mkdtempSync(path.join(tmpdir(), 'env-lane-cli-installer-'))
try {
  const installed = path.join(fixture, 'node_modules/env-lane')
  const native = path.join(fixture, 'node_modules/@env-lane/native')
  const platform = path.join(fixture, `node_modules/@env-lane/native-${platformSuffix()}`)
  mkdirSync(path.join(installed, 'dist'), { recursive: true })
  mkdirSync(path.join(installed, 'scripts'))
  mkdirSync(native, { recursive: true })
  mkdirSync(platform)
  for (const name of ['env-lane', 'env-lane.cmd']) {
    copyFileSync(path.join(root, 'packages/cli/dist', name), path.join(installed, 'dist', name))
  }
  copyFileSync(
    path.join(root, 'packages/cli/scripts/install-native.cjs'),
    path.join(installed, 'scripts/install-native.cjs'),
  )
  copyFileSync(path.join(root, 'packages/native/bin.cjs'), path.join(native, 'bin.cjs'))
  writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: '@env-lane/native' }))
  const addon = `env-lane-native.${platformSuffix()}.node`
  writeFileSync(path.join(platform, 'package.json'), JSON.stringify({ main: addon }))
  writeFileSync(path.join(platform, addon), '')
  copyFileSync(source, path.join(platform, binaryName))

  const stub = path.join(installed, 'dist/env-lane')
  const blocked =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `${stub}.cmd`], {
          encoding: 'utf8',
        })
      : spawnSync('sh', [stub], { encoding: 'utf8' })
  assert.equal(blocked.status, 126, blocked.stderr)
  assert.match(blocked.stderr, /native CLI was not installed/)

  const install = spawnSync(
    process.execPath,
    [path.join(installed, 'scripts/install-native.cjs')],
    {
      encoding: 'utf8',
    },
  )
  assert.equal(install.status, 0, install.stderr)
  const bin = process.platform === 'win32' ? `${stub}.exe` : stub
  const launched = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  })
  assert.equal(launched.status, 0, launched.stderr)
  assert.equal(launched.stdout.trim(), version)
  process.stdout.write('CLI placeholder and native postinstall passed.\n')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
