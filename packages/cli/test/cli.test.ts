import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EnvLaneError, withEnvLaneContext } from '@env-lane/core'
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { registerVaultCommands } from '../../vault/src/cli/index.js'
import { applyCliAliases } from '../src/aliases.js'
import { registerCoreCommands } from '../src/commands/core.js'
import { registerSortCommands } from '../src/commands/sort.js'
import { createCliContext } from '../src/context.js'

function testContext(program: Command) {
  let stdout = ''
  let stderr = ''
  const ctx = createCliContext(program, {
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  })
  return {
    ctx,
    stdout: () => stdout,
    stderr: () => stderr,
    clear: () => {
      stdout = ''
      stderr = ''
    },
  }
}

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
  it('keeps payloads on stdout and structured diagnostics on stderr', async () => {
    const root = fixture()
    const program = new Command()
    const harness = testContext(program)
    harness.ctx.addCommonOptions(program)
    await program.parseAsync(['node', 'cli', '--cwd', root, '--json', '--no-prefix'])
    await harness.ctx.resolveOutputFormat(harness.ctx.mergeOptions({}))

    harness.ctx.logger.diagnostic({
      code: 'TEST_WARNING',
      level: 'warning',
      scope: 'vault',
      message: 'diagnostic only',
    })
    harness.ctx.formatAndLog({ ok: true }, { format: 'json', text: () => undefined })

    expect(JSON.parse(harness.stdout())).toEqual({ ok: true })
    expect(harness.stdout()).not.toContain('TEST_WARNING')
    expect(harness.stderr()).toBe('warning TEST_WARNING: diagnostic only\n')
  })

  it('throws on invalid format', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const { ctx } = testContext(program)
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

  it('preserves root --no-prefix when the subcommand has an implicit default', async () => {
    const root = fixture()
    writeFileSync(
      path.join(root, 'env-lane.config.ts'),
      `export default {
        workspace: { aliases: { api: '@acme/api' } },
        selector: { builds: ['production'], buildValidation: 'warn' }
      };\n`,
    )
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    harness.ctx.addCommonOptions(program)
    registerCoreCommands(program, harness.ctx)

    await withEnvLaneContext({ logger: harness.ctx.logger }, () =>
      program.parseAsync([
        'node',
        'cli',
        '--no-prefix',
        'files',
        'api',
        '--cwd',
        root,
        '--build',
        'unlisted',
      ]),
    )
    expect(harness.stderr()).toContain('warning UNLISTED_BUILD:')
    expect(harness.stderr()).not.toContain('[env-lane]')
  })

  it('includes EnvLaneError details in JSON errors', () => {
    const program = new Command()
    const harness = testContext(program)
    harness.ctx.renderError(
      new EnvLaneError('CONFLICT', 'Conflict found.', { entryId: 'entry-1', hint: 'resolve it' }),
      true,
    )
    expect(JSON.parse(harness.stdout()).error).toEqual({
      code: 'CONFLICT',
      message: 'Conflict found.',
      details: { entryId: 'entry-1', hint: 'resolve it' },
    })
  })

  it('runs packages command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
    registerCoreCommands(program, ctx)

    await program.parseAsync(['node', 'cli', 'packages', '--cwd', root, '--format', 'json'])

    const output = JSON.parse(harness.stdout())
    expect(output.some((p: any) => p.name === '@acme/api')).toBe(true)
  })

  it('runs resolve-target command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
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

    const output = JSON.parse(harness.stdout())
    expect(output.name).toBe('@acme/api')
  })

  it('runs files command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
    registerCoreCommands(program, ctx)

    // target: api
    await program.parseAsync(['node', 'cli', 'files', 'api', '--cwd', root, '--format', 'json'])
    const output = JSON.parse(harness.stdout())
    expect(output.map((f: any) => path.basename(f.path))).toContain('.env')

    // target: all
    harness.clear()
    await program.parseAsync(['node', 'cli', 'files', 'all', '--cwd', root, '--format', 'json'])
    const outputAll = JSON.parse(harness.stdout())
    expect(outputAll[0].target.name).toBe('root')
  })

  it('runs print command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
    registerCoreCommands(program, ctx)

    await program.parseAsync(['node', 'cli', 'print', 'api', '--cwd', root, '--format', 'json'])
    const output = JSON.parse(harness.stdout())
    expect(output.A.value).toBe('1')
  })

  it('runs check command with validations and outputs', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
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
    harness.clear()
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
    const outputPolicy = JSON.parse(harness.stdout())
    expect(outputPolicy.ok).toBe(true)

    // Target check (happy path)
    harness.clear()
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
    const outputTarget = JSON.parse(harness.stdout())
    expect(outputTarget.ok).toBe(true)
  })

  it('runs sync command', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
    registerCoreCommands(program, ctx)

    await program.parseAsync(['node', 'cli', 'sync', 'syncApi', '--cwd', root, '--format', 'json'])
    const output = JSON.parse(harness.stdout())
    expect(output.changed).toBe(true)
    expect(existsSync(path.join(root, 'apps/api/.env.synced'))).toBe(true)
  })

  it('redacts sync mapping values in JSON unless --show-secrets is explicit', async () => {
    const root = fixture()
    writeFileSync(
      path.join(root, 'env-lane.config.ts'),
      `export default {
        workspace: { aliases: { api: '@acme/api' } },
        sync: {
          secrets: {
            from: { target: 'api' },
            to: { file: 'synced-secrets.env' },
            mappings: [{ from: 'SECRET_TOKEN', to: 'SECRET_TOKEN' }]
          }
        }
      };\n`,
    )
    const run = async (showSecrets: boolean) => {
      const program = new Command()
      program.enablePositionalOptions()
      const harness = testContext(program)
      registerCoreCommands(program, harness.ctx)
      await program.parseAsync([
        'node',
        'cli',
        'sync',
        'secrets',
        '--cwd',
        root,
        '--json',
        '--dry-run',
        ...(showSecrets ? ['--show-secrets'] : []),
      ])
      return JSON.parse(harness.stdout()).mappings[0].value
    }

    expect(await run(false)).toBe('<redacted>')
    expect(await run(true)).toBe('abc')
  })

  it('resolves relative Vault config, key, and store paths from --cwd', async () => {
    const root = path.join(tmpdir(), `env-lane-cli-vault-cwd-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'vault-cwd' }))
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'env-lane.vault.json'),
      JSON.stringify({
        envFiles: ['.env'],
        outputDir: '.vault',
        outputFile: 'store.dat',
        disableUnsafeWarning: true,
      }),
    )
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    harness.ctx.addCommonOptions(program)
    registerVaultCommands(program, harness.ctx)

    await program.parseAsync([
      'node',
      'cli',
      'vault',
      'encrypt',
      'key.aes',
      '--cwd',
      root,
      '--json',
    ])
    expect(JSON.parse(harness.stdout()).storePath).toMatch(/\/\.vault\/store\.dat$/)
    expect(existsSync(path.join(root, '.vault/store.dat'))).toBe(true)
  })

  it.each([
    { label: 'with an explicit -- boundary', boundary: ['--'] },
    { label: 'from the child executable without --', boundary: [] },
  ])('passes conflicting child options through $label', async ({ boundary }) => {
    const root = fixture()
    const marker = path.join(root, 'run-result.txt')
    const child = path.join(root, 'capture-args.mjs')
    const childArguments = [
      '--json',
      '--config',
      'child.config.json',
      '--format',
      'child-format',
      '--help',
      '--quiet',
    ]
    writeFileSync(
      child,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`,
    )
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
    registerCoreCommands(program, ctx)
    const previousExitCode = process.exitCode

    try {
      await program.parseAsync([
        'node',
        'cli',
        'run',
        '--cwd',
        root,
        'api',
        '--quiet',
        ...boundary,
        process.execPath,
        child,
        ...childArguments,
      ])
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(childArguments)
      expect(harness.stderr()).toBe('')
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('supports redacted Vault approval files and non-interactive partial apply', async () => {
    const root = path.join(tmpdir(), `env-lane-cli-vault-${Date.now()}`)
    const keyPath = path.join(root, 'key.aes')
    const configPath = path.join(root, 'vault.json')
    const planPath = path.join(root, 'restore-plan.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'vault-fixture' }))
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault-a\nB=vault-b\n')
    writeFileSync(
      configPath,
      JSON.stringify({
        envFiles: ['.env'],
        outputDir: '.vault',
        outputFile: 'store.dat',
        disableUnsafeWarning: true,
      }),
    )

    const makeProgram = () => {
      const program = new Command()
      program.enablePositionalOptions()
      const { ctx } = testContext(program)
      ctx.addCommonOptions(program)
      registerVaultCommands(program, ctx)
      return program
    }

    await makeProgram().parseAsync([
      'node',
      'cli',
      'vault',
      'encrypt',
      keyPath,
      '--vault-config',
      configPath,
      '--cwd',
      root,
      '--json',
    ])
    writeFileSync(path.join(root, '.env'), 'A=local-a\nB=local-b\n')
    await makeProgram().parseAsync([
      'node',
      'cli',
      'vault',
      'plan',
      keyPath,
      '--vault-config',
      configPath,
      '--cwd',
      root,
      '--output',
      planPath,
      '--json',
    ])

    const document = JSON.parse(readFileSync(planPath, 'utf8'))
    expect(JSON.stringify(document)).not.toContain('vault-a')
    expect(JSON.stringify(document)).not.toContain('local-a')
    const entryB = document.plan.files[0].entries.find((entry: any) => entry.key === 'B')
    document.decisions.find((item: any) => item.entryId === entryB.entryId).decision = 'skip'
    writeFileSync(planPath, `${JSON.stringify(document, null, 2)}\n`)

    await makeProgram().parseAsync([
      'node',
      'cli',
      'vault',
      'apply',
      keyPath,
      '--vault-config',
      configPath,
      '--cwd',
      root,
      '--plan',
      planPath,
      '--yes',
      '--non-interactive',
      '--json',
    ])
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=vault-a\nB=local-b\n')
  })

  it('runs sort commands', async () => {
    const root = fixture()
    const program = new Command()
    program.enablePositionalOptions()
    const harness = testContext(program)
    const { ctx } = harness
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
    const sortFileResult = JSON.parse(harness.stdout())
    expect(sortFileResult.applied).toBe(true)

    // Sort from config
    harness.clear()
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
    const sortResult = JSON.parse(harness.stdout())
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
    const { ctx } = testContext(program)
    registerCoreCommands(program, ctx)

    const { loadEnvLaneConfig } = await import('@env-lane/core')
    const config = await loadEnvLaneConfig({ configFile: configPath, cwd: root })
    applyCliAliases(program, config.cli?.aliases ?? {})

    const printCmd = program.commands.find((c) => c.name() === 'print')
    expect(printCmd?.aliases()).toContain('show-env')

    const checkCmd = program.commands.find((c) => c.name() === 'check')
    expect(checkCmd?.aliases()).toContain('validate-env')
  })
})
