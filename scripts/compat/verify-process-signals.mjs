import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (process.platform === 'win32') {
  process.stdout.write('Skipped POSIX signal forwarding checks on Windows\n')
  process.exit(0)
}

const workspace = path.resolve(import.meta.dirname, '../..')
const oracleDir = path.join(workspace, 'compat/oracle/v0.4.2')
const oracle = JSON.parse(readFileSync(path.join(oracleDir, 'manifest.json'), 'utf8'))

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

async function verifySignal(signal) {
  const temporary = mkdtempSync(path.join(tmpdir(), `env-lane-${signal.toLowerCase()}-`))
  try {
    const extraction = spawnSync(
      'tar',
      ['-xzf', path.join(oracleDir, oracle.artifact), '-C', temporary],
      { encoding: 'utf8' },
    )
    if (extraction.status !== 0) throw new Error(extraction.stderr)
    const root = path.join(temporary, 'fixture')
    cpSync(path.join(workspace, 'compat/fixtures/topologies/moment-landing'), root, {
      recursive: true,
    })
    const cli = path.join(temporary, oracle.entrypoint)
    const child = spawn(
      process.execPath,
      [
        cli,
        'run',
        'landing',
        '--cwd',
        root,
        '--config',
        'env-lane.config.json',
        '--quiet',
        '--',
        'node',
        'child-wait.mjs',
      ],
      { cwd: root, stdio: 'ignore' },
    )
    const ready = await waitUntil(() => existsSync(path.join(root, '.child-ready')), 3_000)
    if (!ready) throw new Error(`${signal}: child process did not become ready`)
    const descendantPid = Number(readFileSync(path.join(root, '.child-ready'), 'utf8'))
    const closed = new Promise((resolve) =>
      child.once('close', (code, closeSignal) => resolve({ code, closeSignal })),
    )
    child.kill(signal)
    const result = await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${signal}: CLI did not exit`)), 3_000),
      ),
    ])
    const terminated = await waitUntil(
      () => existsSync(path.join(root, '.child-terminated')),
      3_000,
    )
    if (!terminated) {
      try {
        process.kill(descendantPid, 'SIGTERM')
      } catch {}
      throw new Error(`${signal}: child process survived CLI termination`)
    }
    if (result.closeSignal !== signal) {
      throw new Error(`${signal}: CLI closed with ${result.closeSignal ?? `code ${result.code}`}`)
    }
    return readFileSync(path.join(root, '.child-terminated'), 'utf8')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

const results = Object.fromEntries(
  await Promise.all(
    ['SIGINT', 'SIGTERM'].map(async (signal) => [signal, await verifySignal(signal)]),
  ),
)
process.stdout.write(`Verified POSIX process-tree cleanup ${JSON.stringify(results)}\n`)
