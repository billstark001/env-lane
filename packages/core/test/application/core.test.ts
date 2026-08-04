import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse as parseDotenv } from 'dotenv'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkDotenvSelector,
  type Diagnostic,
  isSecretLikeKey,
  isSecretLikeValue,
  listEnvFiles,
  listWorkspacePackages,
  loadEnvLaneConfig,
  normalizeEnvFileVariant,
  parseEnvDocument,
  parseEnvLine,
  redactObject,
  redactRecord,
  redactValue,
  resolveInjectedEnv,
  resolveTargetPackage,
  runEnvCheck,
  runEnvSync,
  setEnvDocumentValues,
  shouldRedact,
  sortEnvFile,
  sortEnvFilesFromConfig,
  withEnvLaneContext,
  writeFileContentAtomically,
} from '../../src/index.js'

const testDirectories = new Set<string>()

function testDirectory(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`))
  testDirectories.add(root)
  return root
}

afterEach(() => {
  for (const root of testDirectories) rmSync(root, { recursive: true, force: true })
  testDirectories.clear()
})

function fixture(): string {
  const root = testDirectory(`env-lane`)
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
  it('atomically replaces file content without leaving temporary files', () => {
    const root = testDirectory(`env-lane-file-utils`)
    const filePath = path.join(root, 'nested', '.env')
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'before\n')
    if (process.platform !== 'win32') chmodSync(filePath, 0o640)

    writeFileContentAtomically(filePath, 'after\n')

    expect(readFileSync(filePath, 'utf8')).toBe('after\n')
    if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o640)
    expect(readdirSync(path.dirname(filePath))).toEqual(['.env'])
  })

  it.skipIf(process.platform === 'win32')(
    'atomically updates a symbolic-link target without replacing the link',
    () => {
      const root = testDirectory(`env-lane-file-utils-link`)
      const targetPath = path.join(root, 'target.env')
      const linkPath = path.join(root, '.env')
      mkdirSync(root, { recursive: true })
      writeFileSync(targetPath, 'before\n')
      symlinkSync(targetPath, linkPath)

      writeFileContentAtomically(linkPath, 'after\n')

      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf8')).toBe('after\n')
    },
  )

  describe('dotenv line AST', () => {
    it.each([
      'KEY=value',
      'KEY = value # trailing comment',
      'KEY: value',
      'export dotted.key: dotted-value',
      'DASH-KEY=`value # in backticks` # trailing comment',
      "SINGLE=' value # preserved '",
      'DOUBLE="line\\nvalue # preserved"',
      'ESCAPED="quote \\" and # value" # trailing comment',
      'EMPTY= # trailing comment',
    ])('matches dotenv effective values for %s', (source) => {
      const expected = parseDotenv(source)
      const [key, effectiveValue] = Object.entries(expected)[0]
      const line = parseEnvLine(source)

      expect(line.kind).toBe('entry')
      if (line.kind !== 'entry') throw new Error('Expected an entry AST node.')
      expect(line.key).toBe(key)
      expect(line.effectiveValue).toBe(effectiveValue)
      expect(line.separator).toBe(source.includes(':') ? ':' : '=')
    })

    it('parses commented assignments without activating them', () => {
      const line = parseEnvLine('# export dotted.key: value # note')
      expect(line).toMatchObject({
        kind: 'commented-entry',
        key: 'dotted.key',
        separator: ':',
        effectiveValue: 'value',
        suffix: ' # note',
      })
      expect(parseEnvDocument('# export dotted.key: value # note\n').currentMap.size).toBe(0)
    })

    it('rejects syntax that dotenv does not parse', () => {
      expect(parseDotenv('KEY:value')).toEqual({})
      expect(parseEnvLine('KEY:value')).toMatchObject({ kind: 'invalid' })
      expect(parseEnvLine('# ordinary comment')).toMatchObject({ kind: 'comment' })
    })

    it('treats quotes as syntax only when they begin the value token', () => {
      const line = parseEnvLine('MIXED=foo"bar# trailing comment')
      expect(line).toMatchObject({
        kind: 'entry',
        effectiveValue: 'foo"bar',
        valueToken: 'foo"bar',
        suffix: '# trailing comment',
      })
      expect(parseDotenv('MIXED=foo"bar# trailing comment')).toEqual({ MIXED: 'foo"bar' })
    })

    it('uses document-level dotenv semantics for duplicates and multiline values', () => {
      const source = ['A=first', 'A="second\\nline"', 'MULTI="one', 'two"', ''].join('\n')
      const document = parseEnvDocument(source)

      expect(
        Object.fromEntries(
          [...document.currentMap].map(([key, value]) => [key, value.effectiveValue]),
        ),
      ).toEqual(parseDotenv(source))
      expect(document.currentMap.get('A')).toMatchObject({ effectiveValue: 'second\nline' })
      expect(document.currentMap.get('MULTI')).toMatchObject({ effectiveValue: 'one\ntwo' })
      expect(document.shadowedEntryCount).toBe(1)
      expect(document.invalidLineCount).toBe(0)
      expect(document.parsedLines[3]).toMatchObject({
        kind: 'continuation',
        entryLineNumber: 3,
      })
    })

    it('preserves inline comments and activates a matching commented assignment', () => {
      const root = testDirectory(`env-lane-ast-write`)
      mkdirSync(root, { recursive: true })
      const envFile = path.join(root, '.env')
      writeFileSync(envFile, '# KEY: old # keep this note\n')

      setEnvDocumentValues(envFile, [['KEY', 'next # effective']])

      const content = readFileSync(envFile, 'utf8')
      expect(content).toBe('KEY: "next # effective" # keep this note\n')
      expect(parseDotenv(content)).toEqual({ KEY: 'next # effective' })
    })

    it('replaces a multiline assignment without leaving continuation lines behind', () => {
      const root = testDirectory(`env-lane-ast-multiline-write`)
      mkdirSync(root, { recursive: true })
      const envFile = path.join(root, '.env')
      writeFileSync(envFile, 'MULTI="one\ntwo"\nNEXT=value\n')

      setEnvDocumentValues(envFile, [['MULTI', 'replacement']])

      const content = readFileSync(envFile, 'utf8')
      expect(content).toBe('MULTI=replacement\nNEXT=value\n')
      expect(parseDotenv(content)).toEqual({ MULTI: 'replacement', NEXT: 'value' })
    })
  })

  it('uses the shared effective-value model across runtime, checks, sync, and sort', async () => {
    const root = testDirectory(`env-lane-shared-ast`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shared-ast' }))
    writeFileSync(
      path.join(root, 'env-lane.config.ts'),
      `export default {
        selector: { envKey: 'ENV_BUILD', forbidInDotenv: false },
        sync: {
          copy: {
            from: { file: '.env.source' },
            to: { file: '.env.target', variant: 'default' },
            mappings: [{ from: 'SOURCE.VALUE', to: 'TARGET-VALUE' }]
          }
        }
      };\n`,
    )
    writeFileSync(path.join(root, '.env'), 'ENV_BUILD: from-file\nAPP.VALUE: base # note\n')
    writeFileSync(path.join(root, '.env.source'), 'SOURCE.VALUE: actual # source note\n')
    writeFileSync(path.join(root, '.env.target'), 'TARGET-VALUE: old # target note\n')

    const resolved = await resolveInjectedEnv({
      cwd: root,
      target: 'root',
      includeProcessEnv: false,
    })
    expect(resolved.values['APP.VALUE']).toBe('base')

    const selectorCheck = await checkDotenvSelector({ cwd: root, target: 'root' })
    expect(selectorCheck.violations).toContainEqual(
      expect.objectContaining({ relativeFile: '.env', line: 1 }),
    )

    await runEnvSync('copy', { cwd: root })
    const targetContent = readFileSync(path.join(root, '.env.target'), 'utf8')
    expect(targetContent).toBe('TARGET-VALUE: actual # target note\n')
    expect(parseDotenv(targetContent)).toEqual({ 'TARGET-VALUE': 'actual' })

    writeFileSync(path.join(root, '.env.sort'), 'B: two\nA: one\n')
    writeFileSync(path.join(root, '.env.sort.example'), 'A: example\nB: example\n')
    await sortEnvFile(path.join(root, '.env.sort'), path.join(root, '.env.sort.example'))
    expect(readFileSync(path.join(root, '.env.sort'), 'utf8')).toBe('A: one\nB: two\n')
  })

  it('discovers workspace packages and aliases', async () => {
    const root = fixture()
    const packages = await listWorkspacePackages({ cwd: root })
    expect(packages.some((pkg) => pkg.name === '@acme/api')).toBe(true)
    await expect(resolveTargetPackage('api', { cwd: root })).resolves.toMatchObject({
      name: '@acme/api',
    })
  })

  it('falls back to root when there are no subpackages', async () => {
    const root = testDirectory(`env-lane-root`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'single' }))
    await expect(resolveTargetPackage(undefined, { cwd: root })).resolves.toMatchObject({
      isRoot: true,
    })
  })

  it('rejects ambiguous workspace target aliases', async () => {
    const root = testDirectory(`env-lane-ambiguous`)
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
    const root = testDirectory(`env-lane-sort`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, '.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, '.env.example'), 'A=\nB=\nC=\n')
    await sortEnvFile('.env', '.env.example', { cwd: root })
    expect(readFileSync(path.join(root, '.env'), 'utf8').split('\n').slice(0, 3)).toEqual([
      'A=1',
      'B=2',
      '# C=',
    ])
  })

  it('sorts env files while preserving comments, bom, newline style, and extras', async () => {
    const root = testDirectory(`env-lane-sort-layout`)
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

  it('labels variables missing from the template with a configured multiline comment', async () => {
    const root = testDirectory(`env-lane-sort-unlisted`)
    mkdirSync(root, { recursive: true })
    const configFile = path.join(root, 'env-lane.config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        sort: {
          root: {
            baseDir: root,
            file: '.env',
            template: '.env.example',
            unlistedVariablesComment:
              'Variables below are no longer in the template.\nReview before removing them.',
          },
        },
      }),
    )
    writeFileSync(path.join(root, '.env'), 'OLD_B=2\nA=1\nOLD_C=3\n')
    writeFileSync(path.join(root, '.env.example'), 'A=\n')

    await sortEnvFilesFromConfig(configFile, 'root', 'all')
    const firstResult = readFileSync(path.join(root, '.env'), 'utf8')
    await sortEnvFilesFromConfig(configFile, 'root', 'all')

    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(firstResult)
    expect(firstResult).toBe(
      [
        'A=1',
        '',
        '# Variables below are no longer in the template.',
        '# Review before removing them.',
        'OLD_B=2',
        'OLD_C=3',
        '',
      ].join('\n'),
    )
  })

  it.each(['ts', 'mjs', 'cjs', 'js', 'json'])(
    'sorts env files from env-lane %s config sort section',
    async (ext) => {
      const root = testDirectory(`env-lane-sort-config-${ext}`)
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
    },
  )

  it('infers sort targets from workspace packages and builds', async () => {
    const root = testDirectory(`env-lane-sort-inference`)
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
    const root = testDirectory(`env-lane-sort-defaults`)
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
    const root = testDirectory(`env-lane-policy`)
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
    const root = testDirectory(`env-lane-sort-skip`)
    mkdirSync(root, { recursive: true })
    const envFile = path.join(root, '.env')
    const templateFile = path.join(root, '.env.example')
    writeFileSync(templateFile, 'A=\n')

    const result = await sortEnvFile(envFile, templateFile, { create: false })
    expect(result.applied).toBe(false)
    expect(existsSync(envFile)).toBe(false)
  })

  it('deduplicates jobs to avoid sorting the same file multiple times', async () => {
    const root = testDirectory(`env-lane-sort-dedup`)
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
    const root = testDirectory(`env-lane-root-glob`)
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

  it('resolves an explicit relative config file from cwd', async () => {
    const root = fixture()
    const configDir = path.join(root, 'apps/api/config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      path.join(configDir, 'custom.json'),
      JSON.stringify({
        output: { prefix: false },
        sort: { custom: { baseDir: 'apps/api' } },
      }),
    )

    const config = await loadEnvLaneConfig({ cwd: configDir, configFile: 'custom.json' })

    expect(config.rootDir).toBe(root)
    expect(config.output.prefix).toBe(false)
    expect(config.sort?.custom.baseDir).toBe(path.join(root, 'apps/api'))
  })

  it('implicitly resolves and sorts env files from default config file', async () => {
    const root = testDirectory(`env-lane-sort-implicit`)
    mkdirSync(root, { recursive: true })
    const configFile = path.join(root, 'env-lane.config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        selector: { builds: ['local', 'production'] },
        dotenv: { order: ['.env'] },
        sort: {
          custom: {
            baseDir: '.',
            file: '.env',
            template: '.env.example',
          },
        },
      }),
    )
    writeFileSync(path.join(root, '.env'), 'B=2\nA=1\n')
    writeFileSync(path.join(root, '.env.example'), 'A=\nB=\n')

    const result = await sortEnvFilesFromConfig(undefined, 'custom', 'all', { cwd: root })
    expect(result.count).toBe(1)
    expect(result.applied).toBe(true)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=1\nB=2\n')
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
      ).rejects.toMatchObject({ code: 'INVALID_BUILD' })
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
      const diagnostics: Array<{ code: string; message: string }> = []
      const build = await withEnvLaneContext(
        { logger: { diagnostic: (event) => diagnostics.push(event) } },
        () =>
          resolveInjectedEnv({
            cwd: root,
            target: 'api',
            build: 'staging',
            includeProcessEnv: false,
          }),
      )
      expect(build.build).toBe('staging')
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'UNLISTED_BUILD',
          message: expect.stringContaining('is not listed in selector.builds'),
        }),
      )
    })

    it('throws when target package resolution fails', async () => {
      const root = fixture()
      await expect(resolveTargetPackage('non-existent-pkg', { cwd: root })).rejects.toThrow(
        /Unknown target/,
      )

      const { loadEnvLaneConfig } = await import('../../src/index.js')
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
      const tempFile = path.join(testDirectory('env-doc-set-test'), '.env')
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
      const root = testDirectory(`env-lane-bom-eol`)
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

  describe('audited safety boundaries', () => {
    it('recognizes closing quotes preceded by an even number of backslashes', () => {
      const line = parseEnvLine(String.raw`KEY="value\\" # trailing comment`)
      expect(line).toMatchObject({
        kind: 'entry',
        valueToken: String.raw`"value\\"`,
        suffix: ' # trailing comment',
      })
    })

    it('preserves whitespace when a sync mapping has no transform', async () => {
      const root = fixture()
      writeFileSync(path.join(root, 'apps/api/.env'), 'PADDED="  meaningful  "\n')
      writeFileSync(
        path.join(root, 'env-lane.config.ts'),
        `export default {
          workspace: { aliases: { api: '@acme/api' } },
          sync: {
            preserve: {
              from: { target: 'api' },
              to: { file: 'synced.env' },
              mappings: [{ from: 'PADDED', to: 'PADDED' }]
            }
          }
        };\n`,
      )

      await runEnvSync('preserve', { cwd: root })
      expect(
        parseEnvDocument(readFileSync(path.join(root, 'synced.env'), 'utf8')).currentMap.get(
          'PADDED',
        )?.effectiveValue,
      ).toBe('  meaningful  ')
    })

    it('uses the already loaded custom config for target-backed sources', async () => {
      const root = fixture()
      writeFileSync(path.join(root, 'apps/api/.env.custom'), 'A=from-custom-config\n')
      const customConfig = path.join(root, 'custom-env.config.ts')
      writeFileSync(
        customConfig,
        `export default {
          workspace: { aliases: { api: '@acme/api' } },
          dotenv: { order: ['.env.custom'], includeProcessEnv: false },
          sync: {
            custom: {
              from: { target: 'api' },
              to: { file: 'custom-output.env' },
              mappings: [{ from: 'A', to: 'A' }]
            }
          }
        };\n`,
      )

      await runEnvSync('custom', { cwd: root, configFile: customConfig })
      expect(readFileSync(path.join(root, 'custom-output.env'), 'utf8')).toContain(
        'A=from-custom-config',
      )
    })

    it('emits one build diagnostic per environment resolution', async () => {
      const root = fixture()
      writeFileSync(
        path.join(root, 'env-lane.config.ts'),
        `export default {
          workspace: { aliases: { api: '@acme/api' } },
          selector: { builds: ['production'], buildValidation: 'warn' }
        };\n`,
      )
      const diagnostics: Diagnostic[] = []
      await withEnvLaneContext({ logger: { diagnostic: (event) => diagnostics.push(event) } }, () =>
        resolveInjectedEnv({ cwd: root, target: 'api', build: 'staging' }),
      )
      expect(diagnostics.filter((event) => event.code === 'UNLISTED_BUILD')).toHaveLength(1)
    })

    it('directly redacts secret keys, secret values, and nested objects', () => {
      expect(isSecretLikeKey('DATABASE_URL')).toBe(true)
      expect(isSecretLikeValue('postgres://user:password@example.test/db')).toBe(true)
      expect(redactValue('SECRET_TOKEN', 'super-secret')).toBe('<redacted>')
      expect(redactValue('SECRET_TOKEN', 'super-secret', true)).toBe('super-secret')
      expect(redactObject({ nested: { apiKey: 'value' }, safe: 'visible' })).toEqual({
        nested: { apiKey: '<redacted>' },
        safe: 'visible',
      })
    })

    it('covers redaction key allowlists, denylists, and provider credential values', () => {
      for (const key of [
        'password',
        'clientSecret',
        'DATABASE_URL',
        'authorization',
        'webhook-url',
      ]) {
        expect(isSecretLikeKey(key)).toBe(true)
      }
      for (const key of ['PUBLIC_KEY', 'token_count', 'key_id', 'certificate']) {
        expect(isSecretLikeKey(key)).toBe(false)
      }
      expect(isSecretLikeKey('PUBLIC_KEY', { denyListKeys: [/^PUBLIC_KEY$/] })).toBe(true)
      expect(isSecretLikeKey('PASSWORD', { allowListKeys: [/^PASSWORD$/] })).toBe(false)

      for (const value of [
        `ghp_${'A'.repeat(36)}`,
        `sk-proj-${'aB0_'.repeat(8)}`,
        'Bearer abcdefghijklmnopqrstuvwxyz',
        'https://user:password@example.test/database',
        'https://example.test/callback?access_token=abcdefgh1234',
        'config={"client_secret":"abcdefgh1234"}',
      ]) {
        expect(isSecretLikeValue(value)).toBe(true)
      }
      for (const value of [
        'https://example.test/public',
        '1234567890123456789012345678901234567890',
        '550e8400-e29b-41d4-a716-446655440000',
        '0123456789abcdef0123456789abcdef0123456789abcdef',
      ]) {
        expect(isSecretLikeValue(value)).toBe(false)
      }
    })

    it('honors redaction options across records, values, arrays, and circular objects', () => {
      expect(shouldRedact('safe', 'https://user:password@example.test')).toBe(true)
      expect(
        shouldRedact('safe', 'https://user:password@example.test', { detectValues: false }),
      ).toBe(false)
      expect(redactValue('PASSWORD', 'secret', { redactionText: '[hidden]' })).toBe('[hidden]')
      expect(redactRecord({ PASSWORD: 'secret', SAFE: 'visible' })).toEqual({
        PASSWORD: '<redacted>',
        SAFE: 'visible',
      })
      expect(redactObject({ tokens: [{ password: 'secret' }], safe: ['visible'] })).toEqual({
        tokens: [{ password: '<redacted>' }],
        safe: ['visible'],
      })

      const circular: { safe: string; self?: unknown } = { safe: 'visible' }
      circular.self = circular
      expect(redactObject(circular)).toEqual({ safe: 'visible', self: '[Circular]' })
      expect(redactObject({ PASSWORD: 'secret' }, true)).toEqual({ PASSWORD: 'secret' })
    })

    it('rejects sources that specify both target and file', async () => {
      const root = fixture()
      writeFileSync(
        path.join(root, 'env-lane.config.ts'),
        `export default {
          checks: {
            invalid: {
              sources: { ambiguous: { target: 'api', file: '.env' } },
              rules: [{ type: 'required', source: 'ambiguous', key: 'A' }]
            }
          }
        };\n`,
      )
      await expect(runEnvCheck('invalid', { cwd: root })).rejects.toThrow(/but not both/)
    })
  })
})
