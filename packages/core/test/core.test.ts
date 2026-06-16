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
  runEnvCheck,
  runEnvSync,
  sortEnvFile,
  sortEnvFilesFromConfig,
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

function configSource(ext: string, config: unknown): string {
  const json = JSON.stringify(config)
  if (ext === 'json') return json
  if (ext === 'cjs' || ext === 'js') return `module.exports = ${json};\n`
  return `export default ${json};\n`
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

  it('validates configured selector builds when strict mode is enabled', async () => {
    const root = fixture()
    writeFileSync(
      path.join(root, 'env-lane.config.ts'),
      configSource('ts', {
        workspace: { aliases: { api: '@acme/api' } },
        selector: { builds: ['production'], buildValidation: 'error' },
      }),
    )

    await expect(
      resolveInjectedEnv({
        cwd: root,
        target: 'api',
        build: 'staging',
        includeProcessEnv: false,
      }),
    ).rejects.toThrow(/not listed in selector\.builds/)
  })

  it('maps the local build to localOverrideFile for any build pattern', async () => {
    const root = fixture()
    writeFileSync(
      path.join(root, 'env-lane.config.ts'),
      configSource('ts', {
        workspace: { aliases: { api: '@acme/api' } },
        dotenv: {
          order: ['.env', 'deploy/{build}.env'],
          localBuildName: 'local',
          localOverrideFile: '.env.local',
        },
      }),
    )

    const files = await listEnvFiles({ cwd: root, target: 'api', build: 'local' })

    expect(files.map((file) => path.basename(file.path))).toEqual(['.env', '.env.local'])
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

  it.each([
    'ts',
    'mjs',
    'cjs',
    'js',
    'json',
  ])('sorts env files from env-lane %s config sort section', async (ext) => {
    const root = path.join(tmpdir(), `env-lane-sort-config-${ext}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    const configFile = path.join(root, `env-lane.config.${ext}`)
    writeFileSync(
      configFile,
      configSource(ext, {
        sort: {
          api: {
            file: 'apps/api/.env',
            template: 'apps/api/.env.example',
            files: { production: 'apps/api/.env.production' },
          },
        },
      }),
    )
    mkdirSync(path.join(root, 'apps/api'), { recursive: true })
    writeFileSync(path.join(root, 'apps/api/.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, 'apps/api/.env.production'), 'B=20\nA=10\n')
    writeFileSync(path.join(root, 'apps/api/.env.example'), 'A=\nB=\n')

    const result = await sortEnvFilesFromConfig(configFile, 'api', 'all')

    expect(result.count).toBe(2)
    expect(readFileSync(path.join(root, 'apps/api/.env'), 'utf8')).toBe('A=1\nB=2\n')
    expect(readFileSync(path.join(root, 'apps/api/.env.production'), 'utf8')).toBe('A=10\nB=20\n')
  })

  it('infers sort targets from workspace packages and builds', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-inference-${Date.now()}`)
    mkdirSync(path.join(root, 'packages/api'), { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    writeFileSync(path.join(root, 'packages/api/package.json'), JSON.stringify({ name: 'api' }))

    const configFile = path.join(root, 'env-lane.config.ts')
    writeFileSync(
      configFile,
      configSource('ts', {
        selector: { builds: ['prod'] },
        dotenv: { order: ['.env', '.env.{build}'] },
      }),
    )

    writeFileSync(path.join(root, 'packages/api/.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, 'packages/api/.env.prod'), 'B=20\nA=10\n')
    writeFileSync(path.join(root, 'packages/api/.env.example'), 'A=\nB=\n')

    // Test inference using package name 'api'
    const result = await sortEnvFilesFromConfig(configFile, 'api', 'all')
    expect(result.count).toBe(2)
    expect(readFileSync(path.join(root, 'packages/api/.env'), 'utf8')).toBe('A=1\nB=2\n')
    expect(readFileSync(path.join(root, 'packages/api/.env.prod'), 'utf8')).toBe('A=10\nB=20\n')

    // Test inference using relative path 'packages/api'
    writeFileSync(path.join(root, 'packages/api/.env'), 'B=2\nA=1\n')
    await sortEnvFilesFromConfig(configFile, 'packages/api', 'all')
    expect(readFileSync(path.join(root, 'packages/api/.env'), 'utf8')).toBe('A=1\nB=2\n')
  })

  it('fills missing file/template defaults in manual sort config', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-defaults-${Date.now()}`)
    const customDir = path.join(root, 'custom')
    mkdirSync(customDir, { recursive: true })
    const configFile = path.join(root, 'env-lane.config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        sort: {
          custom: {
            baseDir: customDir,
          },
        },
      }),
    )
    writeFileSync(path.join(customDir, '.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(customDir, '.env.example'), 'A=\nB=\n')

    await sortEnvFilesFromConfig(configFile, 'custom', 'all')
    expect(readFileSync(path.join(customDir, '.env'), 'utf8')).toBe('A=1\nB=2\n')
  })

  it('runs configured env checks and sync mappings', async () => {
    const root = path.join(tmpdir(), `env-lane-policy-${Date.now()}`)
    mkdirSync(path.join(root, 'packages/w3'), { recursive: true })
    mkdirSync(path.join(root, 'packages/web'), { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    writeFileSync(path.join(root, 'packages/w3/package.json'), JSON.stringify({ name: 'w3' }))
    writeFileSync(path.join(root, 'packages/web/package.json'), JSON.stringify({ name: 'web' }))
    writeFileSync(
      path.join(root, 'packages/w3/.env.production'),
      'CHAIN_ID=8453\nCONTRACT_ADDRESS=0xABC\nIPFS_GATEWAY_URL=https://ipfs.example/\n',
    )
    writeFileSync(
      path.join(root, 'packages/web/.env.production'),
      'VITE_CHAIN_ID=8453\nVITE_MOMENT_BADGE_ADDRESS=0xabc\n',
    )
    writeFileSync(
      path.join(root, 'env-lane.config.ts'),
      configSource('ts', {
        selector: { builds: ['production'], buildValidation: 'error' },
        checks: {
          deploy: {
            sources: {
              w3: { target: 'w3' },
              web: { target: 'web' },
            },
            rules: [
              { type: 'required', source: 'w3', key: 'CHAIN_ID' },
              {
                type: 'equals',
                left: { source: 'web', key: 'VITE_MOMENT_BADGE_ADDRESS' },
                right: { source: 'w3', key: 'CONTRACT_ADDRESS' },
                transform: 'lowercase',
              },
            ],
          },
        },
        sync: {
          webFromW3: {
            from: { target: 'w3' },
            to: { target: 'web' },
            mappings: [
              { from: 'CHAIN_ID', to: 'VITE_CHAIN_ID' },
              {
                from: 'IPFS_GATEWAY_URL',
                to: 'VITE_IPFS_GATEWAY_BASE',
                transform: 'url-base-slash',
              },
            ],
          },
        },
      }),
    )

    const check = await runEnvCheck('deploy', { cwd: root, build: 'production' })
    expect(check.ok).toBe(true)

    const sync = await runEnvSync('webFromW3', { cwd: root, build: 'production' })
    expect(sync.changed).toBe(true)
    expect(readFileSync(path.join(root, 'packages/web/.env.production'), 'utf8')).toContain(
      'VITE_IPFS_GATEWAY_BASE=https://ipfs.example/',
    )
  })
})
