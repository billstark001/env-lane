import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeRoot, withOracle, workspace } from './rust-support.mjs'

const build = spawnSync('cargo', ['build', '--locked', '--example', 'run-protocol'], {
  cwd: workspace,
  encoding: 'utf8',
})
assert.equal(build.status, 0, build.stderr)
const executable = path.join(
  workspace,
  'target/debug/examples',
  process.platform === 'win32' ? 'run-protocol.exe' : 'run-protocol',
)

function observation(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TEST_INHERITED: 'shell-only' },
  })
  assert.ifError(result.error)
  return normalizeRoot(
    { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
    root,
  )
}

async function until(predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function terminate(command, args, root, signal) {
  for (const file of ['.child-ready', '.child-terminated'])
    rmSync(path.join(root, file), { force: true })
  const child = spawn(command, args, { cwd: root, stdio: 'ignore' })
  let descendant
  try {
    const closed = new Promise((resolve) =>
      child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal })),
    )
    await until(() => existsSync(path.join(root, '.child-ready')), 'Child readiness')
    descendant = Number(readFileSync(path.join(root, '.child-ready'), 'utf8'))
    child.kill(signal)
    const result = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Parent did not terminate')), 5000),
      ),
    ])
    await until(() => existsSync(path.join(root, '.child-terminated')), 'Child cleanup')
    return { ...result, cleanup: readFileSync(path.join(root, '.child-terminated'), 'utf8') }
  } finally {
    child.kill('SIGKILL')
    if (descendant) {
      try {
        process.kill(descendant, 'SIGKILL')
      } catch {}
    }
  }
}

await withOracle(async ({ temporary, runtime }) => {
  const root = path.join(temporary, 'project')
  cpSync(path.join(workspace, 'compat/fixtures/topologies/moment-landing'), root, {
    recursive: true,
  })
  const oracle = path.join(temporary, 'run.mjs')
  const module = pathToFileURL(path.join(runtime, 'node_modules/@env-lane/core/dist/index.js')).href
  writeFileSync(
    oracle,
    `import { readFileSync } from 'node:fs'; import { runWithInjectedEnv } from ${JSON.stringify(module)}; process.exitCode = await runWithInjectedEnv(JSON.parse(readFileSync(process.argv[2], 'utf8')));`,
  )
  writeFileSync(
    path.join(root, 'child-environment.mjs'),
    "process.stdout.write(JSON.stringify({ inherited: process.env.TEST_INHERITED, selector: process.env.LANE, env: process.env.SITE_NAME })); process.stderr.write('child stderr');",
  )
  const requestFile = path.join(temporary, 'request.json')
  const base = {
    cwd: root,
    configFile: path.join(root, 'env-lane.config.json'),
    target: 'landing',
    build: 'local',
  }
  const requests = [
    { command: ['env-lane-synthetic-command-not-found'] },
    { runCwd: 'missing-directory', command: ['node', 'child-cwd.mjs'] },
    { command: ['node', 'child-exit.mjs'] },
    { command: ['node', 'child-cwd.mjs'] },
    { target: 'api', runCwd: 'root', command: ['node', 'child-cwd.mjs'] },
    { target: 'api', runCwd: 'server', command: ['node', '../child-cwd.mjs'] },
    { command: ['node', 'child-environment.mjs'] },
  ]
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(root, 'child-script.cmd'),
      '@echo off\r\necho child-script:%1\r\nexit /b 9\r\n',
    )
    requests.push({ command: ['child-script.cmd', 'value'] })
  }
  if (process.platform !== 'win32')
    requests.push(
      { command: ['node', 'child-signal.mjs'] },
      {
        command: [
          'node',
          'child-argv.mjs',
          'space value',
          '',
          'amp&ersand',
          'dollar$sign',
          'semi;colon',
          'quote"value',
          '--json',
          '--',
          '日本語',
        ],
      },
    )
  for (const includeProcessEnv of [true, false]) {
    const config = JSON.parse(readFileSync(base.configFile, 'utf8'))
    config.dotenv = { ...config.dotenv, includeProcessEnv }
    writeFileSync(base.configFile, JSON.stringify(config))
    for (const request of requests) {
      writeFileSync(requestFile, JSON.stringify({ ...base, ...request }))
      assert.deepEqual(
        observation(executable, [requestFile], root),
        observation(process.execPath, [oracle, requestFile], root),
        JSON.stringify(request),
      )
    }
  }
  if (process.platform !== 'win32') {
    writeFileSync(requestFile, JSON.stringify({ ...base, command: ['node', 'child-wait.mjs'] }))
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const expected = await terminate(process.execPath, [oracle, requestFile], root, signal)
      const actual = await terminate(executable, [requestFile], root, signal)
      assert.deepEqual(actual, expected)
    }
  }
  process.stdout.write(
    `Rust process differential: ${requests.length * 2} executions and platform signal checks passed.\n`,
  )
})
