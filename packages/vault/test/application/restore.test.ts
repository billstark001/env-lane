import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRestorePlan,
  buildRestorePlan,
  createApprovalDocument,
  decryptEnvFiles,
  encryptEnvFiles,
  readApprovalDocument,
  writeApprovalDocument,
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

describe('@env-lane/vault restore', () => {
  it('restores dotenv files without rewriting unmanaged content', async () => {
    const root = testDirectory(`env-lane-vault-restore`)
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

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    writeFileSync(
      path.join(root, '.env'),
      ['# header', 'export A=changed', '', 'UNMANAGED=keep', 'C=local-only', ''].join('\n'),
    )

    const plan = await buildRestorePlan(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {},
    )
    expect(plan.summary.modify).toBe(1)
    expect(plan.summary.add).toBe(1)

    const dec = await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      autoApprove: true,
    })
    expect(dec.filesWritten).toBe(1)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      ['# header', 'export A=1', '', 'UNMANAGED=keep', 'C=local-only', '', 'B=two words', ''].join(
        '\n',
      ),
    )
  })

  it('supports dry-run confirmation and remaps previous checkout paths', async () => {
    const oldRoot = testDirectory(`env-lane-vault-old`)
    const newRoot = testDirectory(`env-lane-vault-new`)
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
    await encryptEnvFiles(path.join(oldRoot, 'vault.json'), path.join(oldRoot, 'key.aes'), {})
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
        autoApprove: true,
      },
    )
    expect(applied.filesWritten).toBe(1)
    expect(readFileSync(path.join(newRoot, 'nested/.env'), 'utf8')).toBe('A=1\n')
  })

  it('builds redacted plans and applies only explicitly selected entries', async () => {
    const root = testDirectory(`env-lane-vault-partial`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault-a\nB=vault-b\nDELETE_ME=vault-delete\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath, {})
    writeFileSync(path.join(root, '.env'), 'A=vault-a\nB=vault-b\n')
    await encryptEnvFiles(configPath, keyPath, {})
    writeFileSync(
      path.join(root, '.env'),
      'A=local-a\nB=local-b\nDELETE_ME=local-delete\nLOCAL_ONLY=kept\n',
    )

    const plan = await buildRestorePlan(configPath, keyPath, {})
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain('vault-a')
    expect(serialized).not.toContain('local-a')
    expect(serialized).not.toContain('local-delete')
    expect(plan.files[0]?.entries.every((entry) => entry.entryId.length === 64)).toBe(true)

    const entryA = plan.files[0]?.entries.find((entry) => entry.key === 'A')
    const entryB = plan.files[0]?.entries.find((entry) => entry.key === 'B')
    const entryDelete = plan.files[0]?.entries.find((entry) => entry.key === 'DELETE_ME')
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(entryDelete?.action).toBe('delete')

    const applied = await applyRestorePlan(configPath, keyPath, plan, {
      autoApprove: true,
      decisions: [
        { entryId: entryA!.entryId, decision: 'apply-vault' },
        { entryId: entryB!.entryId, decision: 'skip' },
        { entryId: entryDelete!.entryId, decision: 'skip' },
      ],
    })
    expect(applied).toMatchObject({ appliedEntries: 1, skippedEntries: 2, filesWritten: 1 })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      'A=vault-a\nB=local-b\nDELETE_ME=local-delete\nLOCAL_ONLY=kept\n',
    )
  })

  it('rejects stale approval plans before writing any file', async () => {
    const root = testDirectory(`env-lane-vault-stale-plan`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath, {})
    writeFileSync(path.join(root, '.env'), 'A=local-one\n')
    const plan = await buildRestorePlan(configPath, keyPath, {})
    const entry = plan.files[0]?.entries[0]
    writeFileSync(path.join(root, '.env'), 'A=local-two\n')

    await expect(
      applyRestorePlan(configPath, keyPath, plan, {
        autoApprove: true,
        decisions: [{ entryId: entry!.entryId, decision: 'apply-vault' }],
      }),
    ).rejects.toMatchObject({ code: 'VAULT_PLAN_STALE' })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=local-two\n')
  })

  it('rejects incomplete approval documents', async () => {
    const root = testDirectory(`env-lane-vault-approval`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    const approvalPath = path.join(root, 'approval.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath)
    writeFileSync(path.join(root, '.env'), 'A=local\n')
    const plan = await buildRestorePlan(configPath, keyPath)
    const document = createApprovalDocument(plan, {})
    document.decisions = []
    writeApprovalDocument(approvalPath, document)

    expect(() => readApprovalDocument(approvalPath)).toThrow(/Invalid Vault approval document/)
  })

  describe('New Features: autoRemapPaths and allowUnmanaged', () => {
    it('behaves correctly under autoRemapPaths and allowUnmanaged controls', async () => {
      const root = testDirectory(`env-lane-vault-features`)
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')

      // Setup old config only managing .env
      const configPath = path.join(root, 'vault.json')
      writeFileSync(
        configPath,
        JSON.stringify({
          envFiles: ['.env'],
          outputDir: '.vault',
          outputFile: 'store.dat',
          autoRemapPaths: true,
          allowUnmanaged: false,
        }),
      )

      const envFile = path.join(root, '.env')
      writeFileSync(envFile, 'A=1\n')

      // 1. Encrypt .env
      await encryptEnvFiles(configPath, path.join(root, 'key.aes'), {})

      // 2. Temporarily write configuration supporting unmanaged file
      writeFileSync(
        configPath,
        JSON.stringify({
          envFiles: ['.env', '.env.unmanaged'],
          outputDir: '.vault',
          outputFile: 'store.dat',
          autoRemapPaths: true,
          allowUnmanaged: false,
        }),
      )
      const unmanagedFile = path.join(root, '.env.unmanaged')
      writeFileSync(unmanagedFile, 'UNMANAGED=100\n')
      await encryptEnvFiles(configPath, path.join(root, 'key.aes'), {})

      // Reset configuration back to only managing .env
      writeFileSync(
        configPath,
        JSON.stringify({
          envFiles: ['.env'],
          outputDir: '.vault',
          outputFile: 'store.dat',
          autoRemapPaths: true,
          allowUnmanaged: false,
        }),
      )
      // Delete local unmanaged file
      try {
        existsSync(unmanagedFile) && require('node:fs').unlinkSync(unmanagedFile)
      } catch {}

      // 3. Decrypt with allowUnmanaged: false (should not restore unmanaged file)
      await decryptEnvFiles(configPath, path.join(root, 'key.aes'), {
        autoApprove: true,
        allowUnmanaged: false,
      })
      expect(existsSync(unmanagedFile)).toBe(false)

      // 4. Decrypt with allowUnmanaged: true (should restore unmanaged file)
      await decryptEnvFiles(configPath, path.join(root, 'key.aes'), {
        autoApprove: true,
        allowUnmanaged: true,
      })
      expect(existsSync(unmanagedFile)).toBe(true)
      expect(readFileSync(unmanagedFile, 'utf8')).toContain('UNMANAGED=100')

      // 5. Test autoRemapPaths: false
      const rootNew = path.join(root, 'new-workspace')
      mkdirSync(rootNew, { recursive: true })
      const remappedConfigPath = path.join(rootNew, 'vault-remap.json')
      writeFileSync(
        remappedConfigPath,
        JSON.stringify({
          envFiles: ['.env'],
          outputDir: path.relative(rootNew, path.join(root, '.vault')),
          outputFile: 'store.dat',
        }),
      )

      const otherFile = path.join(rootNew, '.env')
      try {
        existsSync(otherFile) && require('node:fs').unlinkSync(otherFile)
      } catch {}

      // Decrypt with autoRemapPaths: true (should remap and restore to rootNew/.env)
      await decryptEnvFiles(remappedConfigPath, path.join(root, 'key.aes'), {
        autoApprove: true,
        autoRemapPaths: true,
      })
      expect(existsSync(otherFile)).toBe(true)

      // Decrypt with autoRemapPaths: false (should NOT restore to rootNew/.env)
      try {
        existsSync(otherFile) && require('node:fs').unlinkSync(otherFile)
      } catch {}

      await decryptEnvFiles(remappedConfigPath, path.join(root, 'key.aes'), {
        autoApprove: true,
        autoRemapPaths: false,
      })
      expect(existsSync(otherFile)).toBe(false)
    })
  })

  it('rejects an approval that removes both a plan entry and its decision', async () => {
    const root = testDirectory(`env-lane-vault-plan-entry-set`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    const approvalPath = path.join(root, 'approval.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault-a\nB=vault-b\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath)
    writeFileSync(path.join(root, '.env'), 'A=local-a\nB=local-b\n')
    const document = createApprovalDocument(await buildRestorePlan(configPath, keyPath), {})
    const removedEntry = document.plan.files[0].entries.pop()
    document.decisions = document.decisions.filter(
      (decision) => decision.entryId !== removedEntry?.entryId,
    )
    writeApprovalDocument(approvalPath, document)

    const parsed = readApprovalDocument(approvalPath)
    await expect(
      applyRestorePlan(configPath, keyPath, parsed.plan, {
        autoApprove: true,
        decisions: parsed.decisions,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_PLAN_STALE' })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=local-a\nB=local-b\n')
  })

  it('fails closed when an explicit decision map misses a current entry', async () => {
    const root = testDirectory(`env-lane-vault-missing-decision`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault-a\nB=vault-b\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath)
    writeFileSync(path.join(root, '.env'), 'A=local-a\nB=local-b\n')
    const plan = await buildRestorePlan(configPath, keyPath)

    await expect(
      applyRestorePlan(configPath, keyPath, plan, {
        autoApprove: true,
        decisions: [{ entryId: plan.files[0].entries[0].entryId, decision: 'apply-vault' }],
      }),
    ).rejects.toMatchObject({ code: 'VAULT_MISSING_DECISIONS' })
  })
})
