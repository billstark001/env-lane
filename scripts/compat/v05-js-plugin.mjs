import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import native from '../../packages/native/index.js'
import { createNativeClient } from '../../packages/plugin-sdk/index.mjs'

const workspace = path.resolve(import.meta.dirname, '../..')
const fixture = mkdtempSync(path.join(tmpdir(), 'env-lane-js-plugin-'))
try {
  const modules = path.join(fixture, 'node_modules')
  const pkg = path.join(modules, 'synthetic-plugin')
  mkdirSync(pkg, { recursive: true })
  mkdirSync(path.join(modules, '@env-lane'), { recursive: true })
  symlinkSync(
    path.join(workspace, 'packages/plugin-sdk'),
    path.join(modules, '@env-lane/plugin-sdk'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const capabilities = [
    { kind: 'command', name: 'example' },
    { kind: 'nativeApi', namespace: 'example' },
  ]
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: 'synthetic-plugin',
      type: 'module',
      envLanePlugin: {
        protocolVersion: 1,
        id: 'example',
        capabilities,
        entry: { kind: 'node', path: './plugin.mjs' },
      },
    }),
  )
  writeFileSync(
    path.join(pkg, 'plugin.mjs'),
    `import { servePlugin } from '@env-lane/plugin-sdk';\nawait servePlugin({ id: 'example', capabilities: ${JSON.stringify(capabilities)}, handle(method, params) { if (method === 'command.invoke') return { exitCode: 7 }; if (method === 'native.invoke' && params.operation === 'example.ping') return { pong: true }; throw new Error('Unknown method'); } });\n`,
  )
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'synthetic-fixture' }))
  writeFileSync(
    path.join(fixture, 'env-lane.config.json'),
    JSON.stringify({
      example: { enabled: true, configFile: 'example.ts', packageName: 'synthetic-plugin' },
    }),
  )
  writeFileSync(path.join(fixture, 'example.ts'), 'export default {}\n')
  const cli = path.join(
    workspace,
    'target/debug',
    process.platform === 'win32' ? 'env-lane.exe' : 'env-lane',
  )
  const command = spawnSync(cli, ['--cwd', fixture, 'example', 'ping'], { encoding: 'utf8' })
  assert.equal(command.status, 7, command.stderr)
  const registrations = JSON.parse(
    native.invoke('core.registeredPlugins', JSON.stringify({ cwd: fixture })),
  )
  assert.equal(registrations.ok, true)
  assert.equal(registrations.result.value.plugins[0].packageName, 'synthetic-plugin')
  const runner = spawnSync(
    process.execPath,
    [
      path.join(workspace, 'packages/config-compat/src/cli.mjs'),
      'run',
      '--cwd',
      fixture,
      'example',
      'ping',
    ],
    { encoding: 'utf8', env: { ...process.env, ENV_LANE_NATIVE_BINARY: cli } },
  )
  assert.equal(runner.status, 7, runner.stderr)
  assert.ok(existsSync(path.join(fixture, '.env-lane-cache')))
  assert.ok(readdirSync(path.join(fixture, '.env-lane-cache')).length > 0)
  const hostConfig = {
    rootDir: fixture,
    example: { enabled: true, configFile: 'example.ts', packageName: 'synthetic-plugin' },
  }
  const client = createNativeClient('example', native)
  assert.deepEqual(client.invoke('ping', { projectRoot: fixture, hostConfig }), { pong: true })
  process.stdout.write('0.5.0 JS plugin command, namespace, and TS cache conformance passed.\n')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
