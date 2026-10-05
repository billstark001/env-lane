import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

if (process.env.ENV_LANE_CAPTURE_ORACLE !== '1') {
  throw new Error(
    'Oracle capture is guarded. Re-run with ENV_LANE_CAPTURE_ORACLE=1 after reviewing v0.4.2.',
  )
}

const workspace = path.resolve(import.meta.dirname, '../..')
const destination = path.join(workspace, 'compat/oracle/v0.4.2')
const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-capture-'))
const source = path.join(temporary, 'source')
const runtime = path.join(temporary, 'bundle/runtime')
const packs = path.join(temporary, 'bundle/packs')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspace,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`)
  }
  return result.stdout ?? ''
}

try {
  run('git', ['worktree', 'add', '--detach', source, 'v0.4.2'])
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: source })
  mkdirSync(packs, { recursive: true })
  for (const packageName of ['@env-lane/core', '@env-lane/vault', 'env-lane']) {
    run('pnpm', ['--filter', packageName, 'pack', '--pack-destination', packs], { cwd: source })
  }
  assertExpectedPacks(packs)
  mkdirSync(runtime, { recursive: true })
  cpSync(path.join(destination, 'runtime-package.json'), path.join(runtime, 'package.json'))
  cpSync(
    path.join(destination, 'runtime-package-lock.json'),
    path.join(runtime, 'package-lock.json'),
  )
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime })
  rmSync(path.join(runtime, 'node_modules/.bin'), { recursive: true, force: true })
  const version = run(
    'node',
    [path.join(runtime, 'node_modules/env-lane/dist/cli.js'), '--version'],
    {
      capture: true,
    },
  ).trim()
  if (version !== '0.4.2') throw new Error(`Captured CLI reported ${version}, expected 0.4.2`)

  const artifact = path.join(temporary, 'env-lane-v0.4.2-oracle.tar.gz')
  run('tar', ['-czf', artifact, '-C', path.join(temporary, 'bundle'), 'runtime'])
  mkdirSync(destination, { recursive: true })
  cpSync(artifact, path.join(destination, path.basename(artifact)))
  const manifestPath = path.join(destination, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex')
  manifest.capturedWith = {
    node: process.versions.node,
    pnpm: run('pnpm', ['--version'], { capture: true }).trim(),
    npm: run('npm', ['--version'], { capture: true }).trim(),
    platform: `${process.platform}-${process.arch}`,
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`Captured ${artifact} as ${manifest.sha256}\n`)
} finally {
  spawnSync('git', ['worktree', 'remove', '--force', source], { cwd: workspace, stdio: 'ignore' })
  rmSync(temporary, { recursive: true, force: true })
}

function assertExpectedPacks(directory) {
  const names = readdirSync(directory).sort()
  const expected = ['env-lane-0.4.2.tgz', 'env-lane-core-0.4.2.tgz', 'env-lane-vault-0.4.2.tgz']
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected oracle packs: ${names.join(', ')}`)
  }
}
