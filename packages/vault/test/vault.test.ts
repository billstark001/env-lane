import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRestorePlan,
  decryptEnvFiles,
  encryptEnvFiles,
  sortEnvFile,
  warnUnsafeVault,
} from '../src/index.js'

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
