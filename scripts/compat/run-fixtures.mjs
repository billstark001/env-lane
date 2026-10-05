import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const workspace = path.resolve(import.meta.dirname, '../..')
const casesDir = path.join(workspace, 'compat/fixtures/cases')
const topologiesDir = path.join(workspace, 'compat/fixtures/topologies')
const oracleDir = path.join(workspace, 'compat/oracle/v0.4.2')
const oracleManifest = JSON.parse(readFileSync(path.join(oracleDir, 'manifest.json'), 'utf8'))
const record = process.argv.includes('--record')
const requested = process.argv.find((argument) => argument.startsWith('--case='))?.slice(7)

function normalize(value, root, normalization = {}) {
  let result = value
  if (normalization.root !== false) {
    const roots = [...new Set([realpathSync(root), root])].sort(
      (left, right) => right.length - left.length,
    )
    for (const candidate of roots) {
      result = result
        .replaceAll(candidate.replaceAll('\\', '\\\\'), '$ROOT')
        .replaceAll(candidate, '$ROOT')
    }
  }
  if (normalization.pathSeparators !== false) {
    result = result.replace(/\$ROOT(?:\\+[^"\r\n]*)*/g, (matched) => matched.replace(/\\+/g, '/'))
  }
  if (normalization.timestamps) {
    result = result.replace(/"t":\s*\d+/g, '"t": "$TIMESTAMP"')
    result = result.replace(/\b\d{13}\b/g, '$TIMESTAMP')
  }
  if (normalization.randomCiphertext === 'vault-semantic') {
    result = result.replace(
      /"(planDigest|storeDigest|entryId)": "[0-9a-f]{64}"/g,
      (_match, field) => `"${field}": "$${field.toUpperCase()}"`,
    )
  }
  return result
}

function runStep(step, runtime, root, fixture) {
  const cwd = path.resolve(root, step.cwd ?? '.')
  const env = { ...process.env, TZ: 'UTC', NO_COLOR: '1', FORCE_COLOR: '0' }
  for (const key of fixture.environment?.unset ?? []) delete env[key]
  Object.assign(env, fixture.environment?.set ?? {})
  const command = process.execPath
  const args =
    step.kind === 'cli'
      ? [path.join(runtime, oracleManifest.entrypoint.replace(/^runtime\//, '')), ...step.argv]
      : [
          path.join(workspace, 'scripts/compat/api-driver.mjs'),
          runtime,
          root,
          step.operation,
          JSON.stringify(step.input ?? {}),
        ]
  const result = spawnSync(command, args, {
    cwd,
    env,
    input: step.stdin,
    encoding: 'utf8',
    timeout: 20_000,
  })
  return {
    status: result.status ?? (result.signal ? 128 : 1),
    stdout: normalize(result.stdout ?? '', root, fixture.normalization),
    stderr: normalize(result.stderr ?? '', root, fixture.normalization),
  }
}

const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-compat-'))
try {
  const extraction = spawnSync(
    'tar',
    ['-xzf', path.join(oracleDir, oracleManifest.artifact), '-C', temporary],
    { encoding: 'utf8' },
  )
  if (extraction.status !== 0) throw new Error(extraction.stderr)
  const runtime = path.join(temporary, 'runtime')
  const files = readdirSync(casesDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .filter((file) => !requested || file === `${requested}.json`)
  if (files.length === 0)
    throw new Error(requested ? `Unknown fixture ${requested}` : 'No fixtures')

  const seen = new Set()
  for (const file of files) {
    const casePath = path.join(casesDir, file)
    const fixture = JSON.parse(readFileSync(casePath, 'utf8'))
    if (seen.has(fixture.id)) throw new Error(`Duplicate fixture id ${fixture.id}`)
    seen.add(fixture.id)
    const root = path.join(temporary, `case-${fixture.id}`)
    cpSync(path.join(topologiesDir, fixture.topology), root, { recursive: true })

    for (const [index, step] of fixture.steps.entries()) {
      const observation = runStep(step, runtime, root, fixture)
      if (record) step.expected = observation
      else {
        try {
          assert.deepEqual(observation, step.expected)
        } catch (error) {
          error.message = `${fixture.id} step ${index + 1}: ${error.message}`
          throw error
        }
      }
    }

    const fileObservations = Object.fromEntries(
      (fixture.observeFiles ?? []).map((relative) => {
        const observed = path.join(root, relative)
        let content = existsSync(observed)
          ? normalize(readFileSync(observed, 'utf8'), root, fixture.normalization)
          : null
        if (
          content !== null &&
          fixture.normalization?.randomCiphertext === 'vault-semantic' &&
          relative.endsWith('store.dat')
        ) {
          const lineCount = content.split(/\r?\n/).filter(Boolean).length
          content = `$VAULT_CIPHERTEXT_LINES:${lineCount}\n`
        }
        return [relative, content]
      }),
    )
    if (record) fixture.expectedFiles = fileObservations
    else
      assert.deepEqual(fileObservations, fixture.expectedFiles, `${fixture.id} file tree differs`)
    if (record) writeFileSync(casePath, `${JSON.stringify(fixture, null, 2)}\n`)
    process.stdout.write(`${record ? 'Recorded' : 'Passed'} ${fixture.id}\n`)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
