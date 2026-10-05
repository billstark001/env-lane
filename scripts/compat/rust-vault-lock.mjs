import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { withOracle, workspace } from './rust-support.mjs'

const build = spawnSync('cargo', ['build', '--locked', '--example', 'vault-lock-protocol'], {
  encoding: 'utf8',
})
assert.equal(build.status, 0, build.stderr)
const binary = path.join(
  workspace,
  'target/debug/examples',
  `vault-lock-protocol${process.platform === 'win32' ? '.exe' : ''}`,
)
await withOracle(async ({ temporary, runtime }) => {
  const legacy = await import(
    pathToFileURL(path.join(runtime, 'node_modules/@env-lane/vault/dist/index.js'))
  )
  const storePath = path.join(temporary, 'store.dat')
  const target = `${storePath}.operation`
  const keyFile = path.join(temporary, 'synthetic-key')
  writeFileSync(keyFile, 'synthetic-lock-interoperability')
  writeFileSync(storePath, '')
  const config = {
    baseDir: temporary,
    envFiles: [],
    outputDir: temporary,
    outputFile: 'store.dat',
    storePath,
    autoRemapPaths: true,
    trackDeletions: true,
    allowUnmanaged: false,
    restore: { redaction: 'none', reveal: false, promptLoop: false },
    exclude: [],
    disableUnsafeWarning: true,
  }
  const holder = spawn(binary, [target], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = once(holder, 'exit')
  try {
    await once(holder.stdout, 'data')
    let finished = false
    const plan = legacy
      .buildRestorePlan(undefined, keyFile, { cwd: temporary, resolvedConfig: config })
      .then((value) => {
        finished = true
        return value
      })
    await delay(200)
    assert.equal(finished, false, 'Node entered a Rust-owned operation lock')
    holder.stdin.end()
    assert.equal((await exited)[0], 0)
    await plan
    assert.equal(existsSync(`${target}.lock`), false)
  } finally {
    holder.stdin.end()
    if (holder.exitCode === null) holder.kill()
  }
  // Exercise the exact metadata shape written by Node, including its UUID token.
  writeFileSync(
    `${target}.lock`,
    JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() }),
    { flag: 'wx', mode: 0o600 },
  )
  const waiter = spawn(binary, [target], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiterExited = once(waiter, 'exit')
  let acquired = false
  const ready = once(waiter.stdout, 'data').then(() => {
    acquired = true
  })
  try {
    await delay(200)
    assert.equal(acquired, false, 'Rust entered a Node-owned lock')
    unlinkSync(`${target}.lock`)
    await ready
    waiter.stdin.end()
    assert.equal((await waiterExited)[0], 0)
    assert.equal(existsSync(`${target}.lock`), false)
  } finally {
    waiter.stdin.end()
    if (waiter.exitCode === null) waiter.kill()
  }
  process.stdout.write(
    'Rust Vault locks: frozen Node operation exclusion and Node metadata ownership passed\n',
  )
})
