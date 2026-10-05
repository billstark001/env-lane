import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function terminateTree(command, args, root) {
  for (const file of ['.tree-ready', '.grandchild-ready', '.grandchild-terminated'])
    rmSync(path.join(root, file), { force: true })
  const parent = spawn(command, args, { cwd: root, stdio: 'ignore' })
  let grandchild
  try {
    const closed = new Promise((resolve) =>
      parent.once('close', (code, signal) => resolve({ code, signal })),
    )
    await until(() => existsSync(path.join(root, '.tree-ready')), 'Grandchild readiness')
    await until(
      () => existsSync(path.join(root, '.grandchild-ready')),
      'Grandchild listener readiness',
    )
    grandchild = Number(readFileSync(path.join(root, '.tree-ready'), 'utf8'))
    parent.kill('SIGINT')
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Runner did not stop')), 5000)),
    ])
    await until(() => existsSync(path.join(root, '.grandchild-terminated')), 'Grandchild cleanup')
    return { ...result, cleanup: readFileSync(path.join(root, '.grandchild-terminated'), 'utf8') }
  } finally {
    parent.kill('SIGKILL')
    if (grandchild) {
      try {
        process.kill(grandchild, 'SIGKILL')
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
    mkdirSync(path.join(root, 'tools'))
    writeFileSync(
      path.join(root, 'tools/child-path.cmd'),
      '@echo off\r\necho child-path:%1\r\nexit /b 7\r\n',
    )
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path'
    process.env[pathKey] = `tools${path.delimiter}${process.env[pathKey] ?? ''}`
    requests.push({ command: ['child-path', 'relative'] })
  }
  requests.push({
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
  })
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
  for (const [request, status, diagnostic] of [
    [{ command: ['env-lane-synthetic-command-not-found'] }, 127, 'RUN_COMMAND_NOT_FOUND'],
    [{ runCwd: 'missing-directory', command: ['node', 'child-cwd.mjs'] }, 126, 'RUN_SPAWN_FAILED'],
  ]) {
    writeFileSync(requestFile, JSON.stringify({ ...base, ...request }))
    const actual = observation(executable, [requestFile], root)
    assert.equal(actual.status, status)
    assert.equal(actual.signal, null)
    assert.match(actual.stderr, new RegExp(diagnostic))
    assert.equal(actual.stdout, '')
  }
  if (process.platform !== 'win32') {
    writeFileSync(requestFile, JSON.stringify({ ...base, command: ['node', 'child-signal.mjs'] }))
    const selfSignal = observation(executable, [requestFile], root)
    assert.equal(selfSignal.status, null)
    assert.equal(selfSignal.signal, 'SIGTERM')
    assert.equal(selfSignal.stdout, '')
    assert.equal(selfSignal.stderr, '')
    writeFileSync(requestFile, JSON.stringify({ ...base, command: ['node', 'child-wait.mjs'] }))
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const actual = await terminate(executable, [requestFile], root, signal)
      assert.deepEqual(actual, { code: null, signal, cleanup: signal })
    }
    writeFileSync(
      path.join(root, 'child-tree.mjs'),
      `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', "const fs=require('node:fs');for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{fs.writeFileSync('.grandchild-terminated',signal);process.exit(0)});fs.writeFileSync('.grandchild-ready','ready');setInterval(()=>{},1000)"], { stdio: 'ignore' });
writeFileSync('.tree-ready', String(grandchild.pid));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => setTimeout(() => process.exit(0), 50));
setInterval(() => {}, 1000);`,
    )
    writeFileSync(requestFile, JSON.stringify({ ...base, command: ['node', 'child-tree.mjs'] }))
    assert.deepEqual(await terminateTree(executable, [requestFile], root), {
      code: null,
      signal: 'SIGINT',
      cleanup: 'SIGINT',
    })
  }
  process.stdout.write(
    `Rust process differential: ${requests.length * 2} unchanged executions; 0.5 status and signal checks passed.\n`,
  )
})
