import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadReleasePlan,
  publishEntries,
  readJson,
  releaseTag,
  workspace,
} from './release-plan.mjs'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = loadReleasePlan(workspace, releaseTag())
  if (process.argv.includes('--dry-run')) {
    const entries = publishEntries(plan)
    process.stdout.write(`${entries.map((item) => `${item.name}@${item.version}`).join('\n')}\n`)
    process.stdout.write(`Standalone archives: ${plan.standalone}\n`)
  } else {
    publish(plan)
  }
}

export function npmPublishArgs(packagePath) {
  // Bare paths such as packages/native are parsed as GitHub repository shorthand by npm.
  return [
    'publish',
    path.resolve(workspace, packagePath),
    '--access',
    'public',
    '--provenance',
    '--ignore-scripts',
  ]
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: workspace, stdio: 'inherit', ...options })
  assert.equal(result.status, 0, result.stderr || result.error?.message || `${command} failed`)
  return result
}

function published(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
  })
  if (result.status === 0) return JSON.parse(result.stdout) === version
  let code
  try {
    code = JSON.parse(result.stdout || result.stderr).error?.code
  } catch {}
  assert.equal(code, 'E404', result.stderr || result.error?.message || 'Registry lookup failed')
  return false
}

function publishWorkspace(item) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-release-pack-'))
  try {
    run('pnpm', ['--filter', item.name, 'pack', '--pack-destination', temporary])
    const archives = readdirSync(temporary).filter((entry) => entry.endsWith('.tgz'))
    assert.equal(archives.length, 1, `Expected one package archive for ${item.name}`)
    run('npm', npmPublishArgs(path.join(temporary, archives[0])))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function publish(plan) {
  const entries = publishEntries(plan)
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publishing requires GitHub Actions OIDC')
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, 'Missing GitHub Actions OIDC endpoint')
  assert.ok(!process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN, 'Remove npm publish tokens')
  const version = run('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim()
  assert.ok(version.localeCompare('11.5.1', 'en', { numeric: true }) >= 0, 'npm >= 11.5.1 required')
  const selected = new Set(plan.packages.map((item) => item.name))
  for (const item of plan.packages) {
    const manifest = readJson(workspace, `${item.directory}/package.json`)
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!range.startsWith('workspace:') || selected.has(name)) continue
      assert.ok(
        published(name, range.slice('workspace:^'.length)),
        `${name} dependency is unpublished`,
      )
    }
  }
  if (plan.native || plan.vault) run('node', ['scripts/verify-native-packages.mjs'])
  for (const item of entries) {
    if (published(item.name, item.version)) {
      process.stdout.write(`Already published: ${item.name}@${item.version}; skipping.\n`)
    } else if (item.platform || item.name === '@env-lane/native') {
      run('npm', npmPublishArgs(item.directory))
    } else {
      publishWorkspace(item)
    }
  }
}
