import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const workspace = path.resolve(import.meta.dirname, '../..')

/** Verify the archive before loading any code; always remove its temporary tree. */
export async function withOracle(run) {
  const directory = path.join(workspace, 'compat/oracle/v0.4.2')
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const archive = path.join(directory, manifest.artifact)
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  assert.equal(digest, manifest.sha256, 'Frozen oracle archive checksum changed')
  const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-rust-compat-'))
  try {
    const extraction = spawnSync('tar', ['-xzf', archive, '-C', temporary], { encoding: 'utf8' })
    assert.equal(extraction.status, 0, extraction.stderr)
    return await run({ temporary, runtime: path.join(temporary, 'runtime') })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** A test-only JSON-lines transport, never a fallback in the native executable. */
export function runRustExample(name, requests) {
  const build = spawnSync('cargo', ['build', '--locked', '--example', name], {
    cwd: workspace,
    encoding: 'utf8',
  })
  assert.equal(build.status, 0, build.stderr)
  const executable = path.join(
    workspace,
    'target/debug/examples',
    process.platform === 'win32' ? `${name}.exe` : name,
  )
  const result = spawnSync(executable, [], {
    cwd: workspace,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const actual = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(actual.length, requests.length, 'Native test transport lost a response')
  return actual
}

/** Normalize Node containers only at the test/API boundary, not in Rust domain code. */
export function plainValue(value) {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [key, plainValue(item)]))
  }
  if (Array.isArray(value)) return value.map(plainValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, plainValue(item)]),
    )
  }
  return value
}

/** Normalize path roots without changing backslashes inside dotenv values. */
export function normalizeRoot(value, root) {
  if (typeof value === 'string') {
    if (value.startsWith(root)) return `$ROOT${value.slice(root.length).replaceAll('\\', '/')}`
    return value.replaceAll(root, '$ROOT')
  }
  if (Array.isArray(value)) return value.map((item) => normalizeRoot(item, root))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeRoot(item, root)]),
    )
  return value
}

/** Snapshot every file byte, including unexpected outputs and temporary files. */
export function snapshotTree(root, relative = '') {
  return Object.fromEntries(
    readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(relative, entry.name)
      return entry.isDirectory()
        ? Object.entries(snapshotTree(root, file))
        : [[file, readFileSync(path.join(root, file)).toString('base64')]]
    }),
  )
}

/** Normalize serialized path escapes while retaining CLI byte layout and key order. */
export function normalizeCliObservation(observation, root) {
  const normalize = (value) =>
    value
      .replaceAll(JSON.stringify(root).slice(1, -1), '$ROOT')
      .replaceAll(root, '$ROOT')
      .replace(/\$ROOT(?:\\+[^"\r\n]*)*/g, (matched) => matched.replace(/\\+/g, '/'))
  return {
    ...observation,
    stdout: normalize(observation.stdout),
    stderr: normalize(observation.stderr),
  }
}
