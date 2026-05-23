import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRestorePlan,
  decryptEnvFiles,
  encryptEnvFiles,
  loadVaultConfig,
  warnUnsafeVault,
} from '../src/index.js'

function configSource(ext: string, config: unknown): string {
  const json = JSON.stringify(config)
  if (ext === 'json') return json
  if (ext === 'cjs' || ext === 'js') return `module.exports = ${json};\n`
  return `export default ${json};\n`
}

describe('@env-lane/vault', () => {
  it('emits an unsafe warning unless explicitly disabled', () => {
    const write = vi.fn()
    warnUnsafeVault({ stderr: { write } })
    expect(write).toHaveBeenCalled()
    write.mockClear()
    warnUnsafeVault({ disableUnsafeWarning: true, stderr: { write } })
    expect(write).not.toHaveBeenCalled()
  })

  it('encrypts and decrypts dotenv files', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(enc.setRecordsWritten).toBe(2)
    writeFileSync(path.join(root, '.env'), 'A=changed\n')
    const dec = await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      autoApprove: true,
    })
    expect(dec.filesWritten).toBe(1)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('A=1')
  })

  it('restores dotenv files without rewriting unmanaged content', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-restore-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(
      path.join(root, '.env'),
      ['# header', 'export A=1', '', 'UNMANAGED=keep', 'B=two words', ''].join('\n'),
    )
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    writeFileSync(
      path.join(root, '.env'),
      ['# header', 'export A=changed', '', 'UNMANAGED=keep', 'C=local-only', ''].join('\n'),
    )

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(plan.summary.modify).toBe(1)
    expect(plan.summary.add).toBe(1)

    const dec = await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      autoApprove: true,
    })
    expect(dec.filesWritten).toBe(1)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      ['# header', 'export A=1', '', 'UNMANAGED=keep', 'C=local-only', 'B=two words', ''].join(
        '\n',
      ),
    )
  })

  it('supports dry-run confirmation and remaps previous checkout paths', async () => {
    const oldRoot = path.join(tmpdir(), `env-lane-vault-old-${Date.now()}`)
    const newRoot = path.join(tmpdir(), `env-lane-vault-new-${Date.now()}`)
    mkdirSync(path.join(oldRoot, 'nested'), { recursive: true })
    mkdirSync(path.join(newRoot, 'nested'), { recursive: true })
    writeFileSync(path.join(oldRoot, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(newRoot, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(oldRoot, 'nested/.env'), 'A=1\n')
    writeFileSync(
      path.join(oldRoot, 'vault.json'),
      JSON.stringify({ envFiles: ['nested/.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    writeFileSync(
      path.join(newRoot, 'vault.json'),
      JSON.stringify({ envFiles: ['nested/.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(path.join(oldRoot, 'vault.json'), path.join(oldRoot, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    mkdirSync(path.join(newRoot, '.vault'), { recursive: true })
    writeFileSync(
      path.join(newRoot, '.vault/store.dat'),
      readFileSync(path.join(oldRoot, '.vault/store.dat'), 'utf8'),
    )
    writeFileSync(path.join(newRoot, 'nested/.env'), 'A=changed\n')

    const dryRun = await decryptEnvFiles(
      path.join(newRoot, 'vault.json'),
      path.join(newRoot, 'key.aes'),
      {
        disableUnsafeWarning: true,
        dryRun: true,
      },
    )
    expect(dryRun.aliasedRecords).toBe(1)
    expect(dryRun.filesWritten).toBe(0)
    expect(readFileSync(path.join(newRoot, 'nested/.env'), 'utf8')).toBe('A=changed\n')

    const applied = await decryptEnvFiles(
      path.join(newRoot, 'vault.json'),
      path.join(newRoot, 'key.aes'),
      {
        disableUnsafeWarning: true,
        autoApprove: true,
      },
    )
    expect(applied.filesWritten).toBe(1)
    expect(readFileSync(path.join(newRoot, 'nested/.env'), 'utf8')).toBe('A=1\n')
  })

  it('loads object-style exclude rules, de-dupes env files, and rejects store overlap', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-config-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nSECRET_TOKEN=skip\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      `\uFEFF${JSON.stringify({
        envFiles: ['.env', './.env'],
        outputDir: '.vault',
        outputFile: 'store.dat',
        exclude: { '.env': ['SECRET_*'] },
      })}`,
    )
    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(enc.setRecordsWritten).toBe(1)
    expect(enc.excludedEntriesIgnored).toBe(1)

    writeFileSync(
      path.join(root, 'overlap.json'),
      JSON.stringify({
        envFiles: ['.vault/store.dat'],
        outputDir: '.vault',
        outputFile: 'store.dat',
      }),
    )
    await expect(
      encryptEnvFiles(path.join(root, 'overlap.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      }),
    ).rejects.toThrow(/must not overlap/)
  })

  it.each(['ts', 'mjs', 'cjs', 'js', 'json'])('loads vault %s config files', async (ext) => {
    const root = path.join(tmpdir(), `env-lane-vault-config-format-${ext}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    const configFile = path.join(root, `vault.${ext}`)
    writeFileSync(
      configFile,
      configSource(ext, {
        envFiles: ['.env', './.env'],
        outputDir: '.vault',
        outputFile: 'store.dat',
        exclude: { '.env': ['SECRET_*'] },
      }),
    )

    const config = await loadVaultConfig(configFile)

    expect(config.envFiles).toEqual([path.join(root, '.env')])
    expect(config.storePath).toBe(path.join(root, '.vault/store.dat'))
    expect(config.exclude).toEqual([{ files: ['.env'], keys: ['SECRET_*'] }])
  })

  it('does not record deletions for keys excluded after they were stored', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-exclude-delete-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=one\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=two\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({
        envFiles: ['.env'],
        outputDir: '.vault',
        outputFile: 'store.dat',
        exclude: { '.env': ['SECRET_*'] },
      }),
    )

    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(enc.excludedEntriesIgnored).toBe(1)
    expect(enc.deleteRecordsWritten).toBe(0)

    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(plan.summary.delete).toBe(0)
    expect(plan.files[0]?.entries[0]).toMatchObject({
      key: 'SECRET_TOKEN',
      action: 'modify',
    })
  })

  it('fails closed on unreadable vault records unless explicitly ignored', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-corrupt-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    appendFileSync(path.join(root, '.vault/store.dat'), 'not-valid-record\n')
    writeFileSync(path.join(root, '.env'), 'A=2\n')

    await expect(
      buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      }),
    ).rejects.toThrow(/unreadable record/)
    await expect(
      decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
        autoApprove: true,
      }),
    ).rejects.toThrow(/unreadable record/)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=2\n')

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      ignoreCorruptRecords: true,
    })
    expect(plan.failedRecords).toBe(1)
    expect(plan.summary.modify).toBe(1)
  })
})
