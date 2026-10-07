import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { npmPublishArgs } from '../publish-release.mjs'
import {
  loadReleasePlan,
  packageDirectories,
  publishEntries,
  readJson,
  releaseTag,
  workspace,
} from '../release-plan.mjs'

const temporary = mkdtempSync(path.join(tmpdir(), 'env-lane-release-plan-'))
try {
  mkdirSync(path.join(temporary, 'releases'))
  for (const [name, directory] of Object.entries(packageDirectories)) {
    mkdirSync(path.join(temporary, directory), { recursive: true })
    writeFileSync(
      path.join(temporary, directory, 'package.json'),
      JSON.stringify({ name, version: name === '@env-lane/native' ? '0.5.2' : '0.5.1' }),
    )
  }
  const planFile = path.join(temporary, 'releases/v0.5.2.json')
  const source = { packages: { '@env-lane/native': '0.5.2' }, standalone: true }
  writeFileSync(planFile, JSON.stringify(source))
  const nativeOnly = loadReleasePlan(temporary, 'v0.5.2')
  const entries = publishEntries(nativeOnly)
  assert.equal(entries.length, 9)
  assert.ok(entries.every((item) => item.name.startsWith('@env-lane/native')))
  assert.ok(entries.every((item) => item.version === '0.5.2'))
  assert.equal(nativeOnly.vault, false)
  for (const invalid of [
    { ...source, packages: {} },
    { ...source, packages: { '@env-lane/unknown': '0.5.2' } },
    { ...source, packages: { '@env-lane/native': '0.5.3' } },
    { ...source, packages: { '@env-lane/core': '0.5.1' } },
  ]) {
    writeFileSync(planFile, JSON.stringify(invalid))
    assert.throws(() => loadReleasePlan(temporary, 'v0.5.2'))
  }
  assert.throws(() => releaseTag(['--tag', '../v0.5.2']))
  const jsSource = { packages: { '@env-lane/core': '0.5.1' }, standalone: false }
  writeFileSync(path.join(temporary, 'releases/v0.5.1.json'), JSON.stringify(jsSource))
  const jsOnly = loadReleasePlan(temporary, 'v0.5.1')
  assert.equal(jsOnly.native || jsOnly.vault || jsOnly.standalone, false)
  assert.deepEqual(
    publishEntries(jsOnly).map((item) => item.name),
    ['@env-lane/core'],
  )
  const scopedFile = path.join(temporary, 'releases/core-v0.5.1.json')
  writeFileSync(scopedFile, JSON.stringify(jsSource))
  assert.equal(releaseTag(['--tag', 'core-v0.5.1']), 'core-v0.5.1')
  assert.equal(loadReleasePlan(temporary, 'core-v0.5.1').packages[0].name, '@env-lane/core')
  writeFileSync(
    scopedFile,
    JSON.stringify({ ...jsSource, packages: { '@env-lane/vault': '0.5.1' } }),
  )
  assert.throws(() => loadReleasePlan(temporary, 'core-v0.5.1'))

  const nativeArgs = npmPublishArgs('packages/native')
  assert.equal(nativeArgs[1], path.join(workspace, 'packages/native'))
  const nativePack = spawnSync(
    'npm',
    ['pack', nativeArgs[1], '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd: temporary,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  )
  assert.equal(nativePack.status, 0, nativePack.stderr)
  const nativeMetadata = JSON.parse(nativePack.stdout)
  assert.equal(nativeMetadata.name ?? Object.values(nativeMetadata)[0].name, '@env-lane/native')

  for (const [name, directory] of Object.entries(packageDirectories)) {
    const original = readJson(workspace, `${directory}/package.json`)
    if (!Object.values(original.dependencies ?? {}).some((range) => range.startsWith('workspace:')))
      continue
    const item = { name, directory, version: original.version }
    const packed = spawnSync(
      'pnpm',
      ['--filter', item.name, 'pack', '--pack-destination', temporary],
      {
        cwd: workspace,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    )
    assert.equal(packed.status, 0, packed.stderr)
    const filename = `${item.name.replace('@', '').replace('/', '-')}-${item.version}.tgz`
    const extracted = spawnSync(
      'tar',
      ['-xOzf', path.join(temporary, filename), 'package/package.json'],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(extracted.status, 0, extracted.stderr)
    const manifest = JSON.parse(extracted.stdout)
    for (const [name, range] of Object.entries(original.dependencies ?? {})) {
      if (!range.startsWith('workspace:')) continue
      assert.equal(manifest.dependencies[name], range.slice('workspace:'.length))
      assert.match(manifest.dependencies[name], /^\^\d+\.\d+\.\d+$/)
    }
  }
  process.stdout.write(
    'Selective release plans, independent versions and packed caret dependencies passed.\n',
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
