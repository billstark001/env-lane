import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  checkDotenvSelector,
  listEnvFiles,
  listWorkspacePackages,
  normalizeEnvFileVariant,
  resolveInjectedEnv,
  resolveTargetPackage,
  runEnvCheck,
  runEnvSync,
  setEnvDocumentValues,
  setLogger,
  sortEnvFile,
  sortEnvFilesFromConfig,
} from '../src/index.js'

beforeAll(() => {
  setLogger({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
    write: () => {},
  })
})

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

  it('skips non-existent files when create is false in sort options', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-skip-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    const envFile = path.join(root, '.env')
    const templateFile = path.join(root, '.env.example')
    writeFileSync(templateFile, 'A=\n')

    const result = await sortEnvFile(envFile, templateFile, { create: false })
    expect(result.applied).toBe(false)
    expect(existsSync(envFile)).toBe(false)
  })

  it('deduplicates jobs to avoid sorting the same file multiple times', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-dedup-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    const configFile = path.join(root, 'env-lane.config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        selector: { builds: ['local', 'production'] },
        dotenv: { order: ['.env'] },
        sort: {
          custom: {
            baseDir: root,
            file: '.env',
            template: '.env.example',
          },
        },
      }),
    )
    writeFileSync(path.join(root, '.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, '.env.example'), 'A=\nB=\n')

    const result = await sortEnvFilesFromConfig(configFile, 'custom', 'all')
    expect(result.count).toBe(1)
  })

  it('correctly deduplicates root package even if matched by workspace globs', async () => {
    const root = path.join(tmpdir(), `env-lane-root-glob-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    const packages = await listWorkspacePackages({ cwd: root })
    expect(packages.length).toBe(1)
    expect(packages[0]).toMatchObject({ isRoot: true, relativeDir: '.' })
  })

  it('resolves target from cwd when no target is specified', async () => {
    const root = fixture()
    const apiPkg = await resolveTargetPackage(undefined, { cwd: path.join(root, 'apps/api') })
    expect(apiPkg.name).toBe('@acme/api')

    const rootPkg = await resolveTargetPackage(undefined, { cwd: root })
    expect(rootPkg.isRoot).toBe(true)
  })

  it('implicitly resolves and sorts env files from default config file', async () => {
    const root = path.join(tmpdir(), `env-lane-sort-implicit-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    const configFile = path.join(root, 'env-lane.config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        selector: { builds: ['local', 'production'] },
        dotenv: { order: ['.env'] },
        sort: {
          custom: {
            baseDir: root,
            file: '.env',
            template: '.env.example',
          },
        },
      }),
    )
    writeFileSync(path.join(root, '.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, '.env.example'), 'A=\nB=\n')

    const originalCwd = process.cwd
    process.cwd = () => root
    try {
      const result = await sortEnvFilesFromConfig(undefined, 'custom', 'all')
      expect(result.count).toBe(1)
      expect(result.applied).toBe(true)
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=1\nB=2\n')
    } finally {
      process.cwd = originalCwd
    }
  })

  describe('unhappy paths', () => {
    it('throws when build name is empty or invalid', async () => {
      const root = fixture()
      await expect(
        resolveInjectedEnv({ cwd: root, build: '', includeProcessEnv: false }),
      ).rejects.toThrow('Build name is empty.')
      await expect(
        resolveInjectedEnv({ cwd: root, build: 'prod/build', includeProcessEnv: false }),
      ).rejects.toThrow(/Invalid build name/)
      await expect(
        resolveInjectedEnv({ cwd: root, build: 'a space', includeProcessEnv: false }),
      ).rejects.toThrow(/Invalid build name/)
    })

    it('warns when build name validation mode is warn and not listed', async () => {
      const root = fixture()
      writeFileSync(
        path.join(root, 'env-lane.config.ts'),
        `export default {
          workspace: { aliases: { api: '@acme/api' } },
          selector: { builds: ['production'], buildValidation: 'warn' },
        };\n`,
      )
      const originalLogger = (globalThis as any).__env_lane_logger__
      const warnMock = vi.fn()
      setLogger({
        log: () => {},
        info: () => {},
        warn: warnMock,
        error: () => {},
        success: () => {},
        debug: () => {},
        write: () => {},
      })
      try {
        const build = await resolveInjectedEnv({
          cwd: root,
          target: 'api',
          build: 'staging',
          includeProcessEnv: false,
        })
        expect(build.build).toBe('staging')
        expect(warnMock).toHaveBeenCalledWith(
          expect.stringContaining('is not listed in selector.builds'),
        )
      } finally {
        if (originalLogger) {
          setLogger(originalLogger)
        }
      }
    })

    it('throws when target package resolution fails', async () => {
      const root = fixture()
      await expect(resolveTargetPackage('non-existent-pkg', { cwd: root })).rejects.toThrow(
        /Unknown target/,
      )

      const { loadEnvLaneConfig } = await import('../src/index.js')
      const config = await loadEnvLaneConfig({ cwd: root })
      await expect(
        resolveTargetPackage(undefined, { cwd: '/some/external/path', config }),
      ).rejects.toThrow(/Missing target/)
    })

    it('throws when required dotenv file is missing', async () => {
      const root = fixture()
      // apps/api/.env exists, but production is .env.production. If we require staging:
      await expect(
        resolveInjectedEnv({
          cwd: root,
          target: 'api',
          build: 'staging',
          requireOverride: true,
          includeProcessEnv: false,
        }),
      ).rejects.toThrow(/Missing required env file/)
    })

    it('throws when selector key is present in dotenv file', async () => {
      const root = fixture()
      writeFileSync(path.join(root, 'apps/api/.env'), 'A=1\nENV_BUILD=production\n')
      await expect(
        resolveInjectedEnv({
          cwd: root,
          target: 'api',
          build: 'production',
          includeProcessEnv: false,
        }),
      ).rejects.toThrow(/is a selector and must not be stored in dotenv files/)
    })

    it('sets env values and removes duplicate entries using setEnvDocumentValues', () => {
      const tempFile = path.join(tmpdir(), `env-doc-set-test-${Date.now()}.env`)
      writeFileSync(tempFile, 'A=1\nB=2\nA=3\n')
      const result = setEnvDocumentValues(tempFile, [
        ['B', '20'],
        ['C', '30'],
      ])

      expect(result.changed).toBe(true)
      const content = readFileSync(tempFile, 'utf8')
      expect(content).toContain('B=20')
      expect(content).toContain('C=30')
    })

    it('throws on invalid env file variant syntax during sync', async () => {
      const root = fixture()
      writeFileSync(
        path.join(root, 'env-lane.config.ts'),
        `export default {
          sync: {
            invalidVariantSync: {
              from: { target: 'api' },
              to: { target: 'api', variant: 'invalid/variant' },
              mappings: [{ from: 'A', to: 'B' }]
            }
          }
        };\n`,
      )
      await expect(runEnvSync('invalidVariantSync', { cwd: root })).rejects.toThrow(
        /Invalid sync target variant/,
      )
    })

    it('throws when sort config or template does not exist', async () => {
      const root = fixture()
      await expect(
        sortEnvFilesFromConfig(path.join(root, 'non-existent-config.json')),
      ).rejects.toThrow(/Sort config does not exist/)

      const envFile = path.join(root, 'apps/api/.env')
      const missingTemplate = path.join(root, 'apps/api/non-existent-template.env')
      await expect(sortEnvFile(envFile, missingTemplate)).rejects.toThrow(
        /Template env file does not exist/,
      )
    })

    it('throws on unknown sort key selector', async () => {
      const root = fixture()
      const configFile = path.join(root, 'env-lane.config.ts')
      await expect(sortEnvFilesFromConfig(configFile, 'non-existent-key', 'all')).rejects.toThrow(
        /Unknown sort key/,
      )
    })

    it('throws when sort files uses reserved word default', async () => {
      const root = fixture()
      const configFile = path.join(root, 'invalid-sort-config.json')
      writeFileSync(
        configFile,
        JSON.stringify({
          sort: {
            custom: {
              baseDir: root,
              file: '.env',
              template: '.env.example',
              files: { default: '.env.prod' },
            },
          },
        }),
      )
      await expect(sortEnvFilesFromConfig(configFile, 'custom', 'all')).rejects.toThrow(
        /must not use reserved suffix "default"/,
      )
    })

    it('throws on unknown env check or sync names', async () => {
      const root = fixture()
      await expect(runEnvCheck('non-existent-check', { cwd: root })).rejects.toThrow(
        /Unknown env check/,
      )
      await expect(runEnvSync('non-existent-sync', { cwd: root })).rejects.toThrow(
        /Unknown env sync/,
      )
    })

    it('throws when sync target has neither target nor file', async () => {
      const root = fixture()
      writeFileSync(
        path.join(root, 'env-lane.config.ts'),
        `export default {
          sync: {
            invalidSync: {
              from: { target: 'api' },
              to: {}, // empty
              mappings: [{ from: 'A', to: 'B' }]
            }
          }
        };\n`,
      )
      await expect(runEnvSync('invalidSync', { cwd: root })).rejects.toThrow(
        /source must include target or file/,
      )
    })
  })

  describe('normalizeEnvFileVariant without legacy alias mappings', () => {
    it('returns valid variants directly including default', () => {
      expect(normalizeEnvFileVariant('production')).toBe('production')
      expect(normalizeEnvFileVariant('default')).toBe('default')
      expect(normalizeEnvFileVariant('base')).toBe('base')
      expect(normalizeEnvFileVariant('root')).toBe('root')
      expect(normalizeEnvFileVariant(undefined)).toBe('')
    })

    it('throws on invalid variant names containing dots or slashes', () => {
      expect(() => normalizeEnvFileVariant('.env.production')).toThrow(/Invalid env file variant/)
      expect(() => normalizeEnvFileVariant('invalid/variant')).toThrow(/Invalid env file variant/)
    })
  })

  describe('BOM and EOL configuration feature', () => {
    it('applies preserveBOM and eol configurations when patching documents', async () => {
      const root = path.join(tmpdir(), `env-lane-bom-eol-${Date.now()}`)
      mkdirSync(root, { recursive: true })
      const envFile = path.join(root, '.env')

      // Initialize with BOM and LF
      writeFileSync(envFile, '\uFEFFA=1\n')

      // Force LF and strip BOM (preserveBOM: false)
      setEnvDocumentValues(envFile, [['B', '2']], { preserveBOM: false, eol: 'lf' })
      const lfContent = readFileSync(envFile, 'utf8')
      expect(lfContent.startsWith('\uFEFF')).toBe(false)
      expect(lfContent).toBe('A=1\n\nB=2\n')

      // Re-initialize with BOM to test preservation
      writeFileSync(envFile, '\uFEFFA=1\n\nB=2\n')

      // Force CRLF and preserve BOM (preserveBOM: true)
      setEnvDocumentValues(envFile, [['C', '3']], { preserveBOM: true, eol: 'crlf' })
      const crlfContent = readFileSync(envFile, 'utf8')
      expect(crlfContent.startsWith('\uFEFF')).toBe(true)
      expect(crlfContent).toContain('A=1\r\n\r\nB=2\r\n\r\nC=3\r\n')
    })
  })
})
