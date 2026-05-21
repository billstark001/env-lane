import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDotenvSelector,
  listEnvFiles,
  listWorkspacePackages,
  resolveInjectedEnv,
  resolveTargetPackage,
  sortEnvFile,
} from '../src/index.js'

function fixture(): string {
  const root = path.join(tmpdir(), `env-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(path.join(root, 'apps/api'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  writeFileSync(
    path.join(root, 'env-lane.config.ts'),
    `export default { workspace: { aliases: { api: '@acme/api' } } };\n`,
  )
  writeFileSync(path.join(root, 'apps/api/package.json'), JSON.stringify({ name: '@acme/api' }))
  writeFileSync(path.join(root, 'apps/api/.env'), 'A=1\nSECRET_TOKEN=abc\n')
  writeFileSync(path.join(root, 'apps/api/.env.production'), 'A=2\nB=3\n')
  return root
}

describe('@env-lane/core', () => {
  it('discovers workspace packages and aliases', async () => {
    const root = fixture()
    const packages = await listWorkspacePackages({ cwd: root })
    expect(packages.some((pkg) => pkg.name === '@acme/api')).toBe(true)
    await expect(resolveTargetPackage('api', { cwd: root })).resolves.toMatchObject({
      name: '@acme/api',
    })
  })

  it('falls back to root when there are no subpackages', async () => {
    const root = path.join(tmpdir(), `env-lane-root-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'single' }))
    await expect(resolveTargetPackage(undefined, { cwd: root })).resolves.toMatchObject({
      isRoot: true,
    })
  })

  it('rejects ambiguous workspace target aliases', async () => {
    const root = path.join(tmpdir(), `env-lane-ambiguous-${Date.now()}`)
    mkdirSync(path.join(root, 'apps/api'), { recursive: true })
    mkdirSync(path.join(root, 'packages/api'), { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n')
    writeFileSync(path.join(root, 'apps/api/package.json'), JSON.stringify({ name: '@acme/api' }))
    writeFileSync(
      path.join(root, 'packages/api/package.json'),
      JSON.stringify({ name: '@acme/api-tools' }),
    )

    await expect(resolveTargetPackage('api', { cwd: root })).rejects.toThrow(
      /Ambiguous target 'api'/,
    )
    await expect(resolveTargetPackage('apps/api', { cwd: root })).resolves.toMatchObject({
      relativeDir: 'apps/api',
    })
  })

  it('lists files and resolves injected env in order', async () => {
    const root = fixture()
    const files = await listEnvFiles({ cwd: root, target: 'api', build: 'production' })
    expect(files.map((file) => path.basename(file.path))).toEqual(['.env', '.env.production'])
    const resolved = await resolveInjectedEnv({
      cwd: root,
      target: 'api',
      build: 'production',
      includeProcessEnv: false,
    })
    expect(resolved.values.A).toBe('2')
    expect(resolved.values.B).toBe('3')
    expect(resolved.values.ENV_BUILD).toBe('production')
  })

  it('reports selector violations with target filtering and line numbers', async () => {
    const root = fixture()
    mkdirSync(path.join(root, 'apps/web'), { recursive: true })
    writeFileSync(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: '@acme/web' }))
    writeFileSync(path.join(root, 'apps/web/.env'), 'A=1\nENV_BUILD=bad\n')

    await expect(checkDotenvSelector({ cwd: root, target: 'api' })).resolves.toMatchObject({
      ok: true,
    })
    const result = await checkDotenvSelector({ cwd: root, target: 'all' })
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      expect.objectContaining({ relativeFile: 'apps/web/.env', line: 2 }),
    ])
  })

  it('reports missing override files during selector checks when required', async () => {
    const root = fixture()
    const result = await checkDotenvSelector({
      cwd: root,
      target: 'api',
      build: 'staging',
      requireOverride: true,
    })
    expect(result.ok).toBe(false)
    expect(result.missingRequired).toEqual([
      expect.objectContaining({ relativeFile: 'apps/api/.env.staging', target: '@acme/api' }),
    ])
  })

  it('sorts env file using template order', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, '.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, '.env.example'), 'A=\nB=\nC=\n')
    await sortEnvFile(path.join(root, '.env'), path.join(root, '.env.example'))
    expect(readFileSync(path.join(root, '.env'), 'utf8').split('\n').slice(0, 3)).toEqual([
      'A=1',
      'B=2',
      '# C=',
    ])
  })

  it('sorts env files while preserving comments, bom, newline style, and extras', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-layout-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(
      path.join(root, '.env'),
      '\uFEFF# template header\r\n# local B\r\nB=2\r\n\r\n# local A\r\nA=1\r\nEXTRA=9\r\n',
    )
    writeFileSync(
      path.join(root, '.env.example'),
      '# template header\r\n# template A\r\nA=\r\n# template B\r\nB=\r\nC=\r\n',
    )
    const result = await sortEnvFile(path.join(root, '.env'), path.join(root, '.env.example'))
    const sorted = readFileSync(path.join(root, '.env'), 'utf8')
    expect(result.insertedCommentedCount).toBe(1)
    expect(sorted.startsWith('\uFEFF# template header\r\n')).toBe(true)
    expect(sorted).toContain('# template A\r\n\r\n# local A\r\nA=1')
    expect(sorted).toContain('# template B\r\n\r\n# local B\r\nB=2')
    expect(sorted).toContain('\r\n# C=')
    expect(sorted.endsWith('\r\n')).toBe(true)
    expect(sorted.indexOf('A=1')).toBeLessThan(sorted.indexOf('B=2'))
    expect(sorted.indexOf('B=2')).toBeLessThan(sorted.indexOf('EXTRA=9'))
  })
})
