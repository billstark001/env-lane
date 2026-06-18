import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLogger } from '@env-lane/core'
import { Command } from 'commander'
import { createConsola } from 'consola'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { registerCoreCommands } from '../src/commands/core.js'
import { registerSortCommands } from '../src/commands/sort.js'
import { createCliContext } from '../src/context.js'

vi.mock('@env-lane/core', async () => {
  const actual =
    await vi.importActual<typeof import('../../core/src/index.js')>('../../core/src/index.js')
  return actual
})

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
  const root = path.join(
    tmpdir(),
    `env-lane-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  mkdirSync(path.join(root, 'apps/api'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
  writeFileSync(
    path.join(root, 'env-lane.config.ts'),
    `export default {
      workspace: { aliases: { api: '@acme/api' } },
      checks: {
        dev: {
          sources: { api: { target: 'api' } },
          rules: [{ type: 'required', source: 'api', key: 'A' }]
        }
      },
      sync: {
        syncApi: {
          from: { target: 'api' },
          to: { file: 'apps/api/.env.synced' },
          mappings: [{ from: 'A', to: 'A_SYNCED' }]
        }
      }
    };\n`,
  )
  writeFileSync(path.join(root, 'apps/api/package.json'), JSON.stringify({ name: '@acme/api' }))
  writeFileSync(path.join(root, 'apps/api/.env'), 'SECRET_TOKEN=abc\nA=1\n')
  writeFileSync(path.join(root, 'apps/api/.env.production'), 'A=2\nB=3\n')
  writeFileSync(path.join(root, 'apps/api/.env.example'), 'A=\nSECRET_TOKEN=\n')
  return root
}

describe('CLI context & commands', () => {
  it('throws on invalid format', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const ctx = createCliContext(program, consola)
    ctx.addCommonOptions(program)

    // We register a dummy command to trigger resolveOutputFormat
    const dummy = program.command('dummy')
    ctx.addCommonOptions(dummy)
    dummy.action(async (opts) => {
      const allOpts = ctx.mergeOptions(opts)
      await ctx.resolveOutputFormat(allOpts)
    })

    await expect(
      program.parseAsync(['node', 'cli', 'dummy', '--format', 'invalid-format', '--cwd', root]),
    ).rejects.toThrow('--format must be one of: text, json, dotenv')
  })

  it('runs packages command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    await program.parseAsync(['node', 'cli', 'packages', '--cwd', root, '--format', 'json'])

    expect(logSpy).toHaveBeenCalled()
    const output = JSON.parse(logSpy.mock.calls[0][0])
    expect(output.some((p: any) => p.name === '@acme/api')).toBe(true)
  })

  it('runs resolve-target command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    await program.parseAsync([
      'node',
      'cli',
      'resolve-target',
      'api',
      '--cwd',
      root,
      '--format',
      'json',
    ])

    expect(logSpy).toHaveBeenCalled()
    const output = JSON.parse(logSpy.mock.calls[0][0])
    expect(output.name).toBe('@acme/api')
  })

  it('runs files command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    // target: api
    await program.parseAsync(['node', 'cli', 'files', 'api', '--cwd', root, '--format', 'json'])
    expect(logSpy).toHaveBeenCalled()
    const output = JSON.parse(logSpy.mock.calls[0][0])
    expect(output.map((f: any) => path.basename(f.path))).toContain('.env')

    // target: all
    logSpy.mockClear()
    await program.parseAsync(['node', 'cli', 'files', 'all', '--cwd', root, '--format', 'json'])
    expect(logSpy).toHaveBeenCalled()
    const outputAll = JSON.parse(logSpy.mock.calls[0][0])
    expect(outputAll[0].target.name).toBe('root')
  })

  it('runs print command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    await program.parseAsync(['node', 'cli', 'print', 'api', '--cwd', root, '--format', 'json'])
    expect(logSpy).toHaveBeenCalled()
    const output = JSON.parse(logSpy.mock.calls[0][0])
    expect(output.A.value).toBe('1')
  })

  it('runs check command with validations and outputs', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    // Option error: both policy and target
    await expect(
      program.parseAsync([
        'node',
        'cli',
        'check',
        '--policy',
        'dev',
        '--target',
        'api',
        '--cwd',
        root,
      ]),
    ).rejects.toThrow('Use either --policy or --target, not both.')

    // Option error: neither policy nor target
    await expect(program.parseAsync(['node', 'cli', 'check', '--cwd', root])).rejects.toThrow(
      'Missing check selection. Use --policy <name> or --target <target>.',
    )

    // Policy check (happy path)
    logSpy.mockClear()
    await program.parseAsync([
      'node',
      'cli',
      'check',
      '--policy',
      'dev',
      '--cwd',
      root,
      '--format',
      'json',
    ])
    expect(logSpy).toHaveBeenCalled()
    const outputPolicy = JSON.parse(logSpy.mock.calls[0][0])
    expect(outputPolicy.ok).toBe(true)

    // Target check (happy path)
    logSpy.mockClear()
    await program.parseAsync([
      'node',
      'cli',
      'check',
      '--target',
      'api',
      '--cwd',
      root,
      '--format',
      'json',
    ])
    expect(logSpy).toHaveBeenCalled()
    const outputTarget = JSON.parse(logSpy.mock.calls[0][0])
    expect(outputTarget.ok).toBe(true)
  })

  it('runs sync command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    await program.parseAsync(['node', 'cli', 'sync', 'syncApi', '--cwd', root, '--format', 'json'])
    expect(logSpy).toHaveBeenCalled()
    const output = JSON.parse(logSpy.mock.calls[0][0])
    expect(output.changed).toBe(true)
    expect(existsSync(path.join(root, 'apps/api/.env.synced'))).toBe(true)
  })

  it('runs sort commands', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {})

    const ctx = createCliContext(program, consola)
    registerSortCommands(program, ctx)

    // Sort single file
    const envFile = path.join(root, 'apps/api/.env')
    const templateFile = path.join(root, 'apps/api/.env.example')
    await program.parseAsync([
      'node',
      'cli',
      'sort-file',
      envFile,
      templateFile,
      '--cwd',
      root,
      '--format',
      'json',
    ])
    expect(logSpy).toHaveBeenCalled()
    const sortFileResult = JSON.parse(logSpy.mock.calls[0][0])
    expect(sortFileResult.applied).toBe(true)

    // Sort from config
    logSpy.mockClear()
    await program.parseAsync([
      'node',
      'cli',
      'sort',
      'api',
      'all',
      '--config',
      path.join(root, 'env-lane.config.ts'),
      '--cwd',
      root,
      '--format',
      'json',
    ])
    expect(logSpy).toHaveBeenCalled()
    const sortResult = JSON.parse(logSpy.mock.calls[0][0])
    expect(sortResult.count).toBeGreaterThan(0)
  })

  it('applies custom CLI command aliases from configuration', async () => {
    const root = fixture()
    const configPath = path.join(root, 'env-lane.config.ts')
    writeFileSync(
      configPath,
      `export default {
        workspace: { aliases: { api: '@acme/api' } },
        cli: {
          aliases: {
            "print": "show-env",
            "check": "validate-env"
          }
        }
      };\n`,
    )

    const program = new Command()
    program.enablePositionalOptions()
    const consola = createConsola({ level: 0 })
    const ctx = createCliContext(program, consola)
    registerCoreCommands(program, ctx)

    const { loadEnvLaneConfig } = await import('@env-lane/core')
    const config = await loadEnvLaneConfig({ configFile: configPath, cwd: root })
    if (config.cli?.aliases) {
      for (const [cmdName, alias] of Object.entries(config.cli.aliases)) {
        const cmd = program.commands.find((c) => c.name() === cmdName)
        if (cmd) {
          cmd.alias(alias)
        }
      }
    }

    const printCmd = program.commands.find((c) => c.name() === 'print')
    expect(printCmd?.aliases()).toContain('show-env')

    const checkCmd = program.commands.find((c) => c.name() === 'check')
    expect(checkCmd?.aliases()).toContain('validate-env')
  })
})
