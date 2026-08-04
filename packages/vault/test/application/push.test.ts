import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRestorePlan,
  decryptEnvFiles,
  decryptRecord,
  deriveVaultKey,
  encryptEnvFiles,
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

function storeLineCount(root: string): number {
  return readFileSync(path.join(root, '.vault/store.dat'), 'utf8').split(/\r?\n/).filter(Boolean)
    .length
}

describe('@env-lane/vault push', () => {
  it('previews a first push without creating a store, sync state, or output directories', async () => {
    const root = testDirectory(`env-lane-vault-dry-run-new`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    const result = await encryptEnvFiles(configPath, keyPath, {
      dryRun: true,
      syncDir: '.sync',
      cwd: root,
    })

    expect(result).toMatchObject({
      applied: false,
      dryRun: true,
      setRecordsWritten: 2,
      deleteRecordsWritten: 0,
    })
    expect(result.changes).toHaveLength(2)
    expect(existsSync(path.join(root, '.vault'))).toBe(false)
    expect(existsSync(path.join(root, '.sync'))).toBe(false)
  })

  it('does not modify an existing store or sync state during dry-run', async () => {
    const root = testDirectory(`env-lane-vault-dry-run-existing`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    const syncDir = path.join(root, '.sync')
    const storePath = path.join(root, '.vault/store.dat')
    const syncStatePath = path.join(syncDir, 'vault-sync-state.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath, { syncDir })
    const storeBefore = readFileSync(storePath, 'utf8')
    const syncBefore = readFileSync(syncStatePath, 'utf8')
    writeFileSync(path.join(root, '.env'), 'A=changed\nC=3\n')

    const result = await encryptEnvFiles(configPath, keyPath, {
      dryRun: true,
      syncDir,
      conflictStrategy: 'keep-local',
    })

    expect(result).toMatchObject({ applied: false, dryRun: true })
    expect(result.changes.length).toBeGreaterThan(0)
    expect(readFileSync(storePath, 'utf8')).toBe(storeBefore)
    expect(readFileSync(syncStatePath, 'utf8')).toBe(syncBefore)
  })

  it('treats a missing managed file exactly like an empty file without changing file existence', async () => {
    const root = testDirectory(`env-lane-vault-missing-as-empty`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    const missingFile = path.join(root, '.env.missing')
    const emptyFile = path.join(root, '.env.empty')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(missingFile, 'A=1\n')
    writeFileSync(emptyFile, 'B=2\n')
    writeFileSync(
      configPath,
      JSON.stringify({
        envFiles: ['.env.missing', '.env.empty'],
        outputDir: '.vault',
        outputFile: 'store.dat',
      }),
    )
    await encryptEnvFiles(configPath, keyPath)
    rmSync(missingFile)
    writeFileSync(emptyFile, '')

    const result = await encryptEnvFiles(configPath, keyPath)

    expect(result).toMatchObject({
      deleteRecordsWritten: 2,
      missingFilesSkipped: 0,
      missingFilesTreatedAsEmpty: 1,
    })
    expect(existsSync(missingFile)).toBe(false)
    expect(existsSync(emptyFile)).toBe(true)
    expect(readFileSync(emptyFile, 'utf8')).toBe('')
    const records = readFileSync(path.join(root, '.vault/store.dat'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .slice(-2)
      .map((line) => JSON.parse(decryptRecord(deriveVaultKey(keyPath), line)))
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ f: '.env.missing', k: 'A', op: 'delete' }),
        expect.objectContaining({ f: '.env.empty', k: 'B', op: 'delete' }),
      ]),
    )
    await expect(buildRestorePlan(configPath, keyPath)).resolves.toMatchObject({
      summary: { identical: 2, conflict: 0 },
    })
  })

  it('can explicitly skip a missing managed file', async () => {
    const root = testDirectory(`env-lane-vault-skip-missing`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    const envFile = path.join(root, '.env')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(envFile, 'A=1\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath)
    rmSync(envFile)

    const result = await encryptEnvFiles(configPath, keyPath, { missingFiles: 'skip' })

    expect(result).toMatchObject({
      deleteRecordsWritten: 0,
      missingFilesSkipped: 1,
      missingFilesTreatedAsEmpty: 0,
    })
    expect(storeLineCount(root)).toBe(1)
    expect(existsSync(envFile)).toBe(false)
  })

  it('shares dotenv effective-value semantics and preserves local inline comments', async () => {
    const root = testDirectory(`env-lane-vault-effective`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A: one # original note\nEMPTY= # empty note\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    const first = await encryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {},
    )
    expect(first.setRecordsWritten).toBe(2)
    const firstRecord = JSON.parse(
      decryptRecord(
        deriveVaultKey(path.join(root, 'key.aes')),
        readFileSync(path.join(root, '.vault/store.dat'), 'utf8').trim().split(/\r?\n/)[0],
      ),
    )
    expect(firstRecord).toMatchObject({ version: 1, f: '.env', k: 'A', v: 'one' })
    expect(JSON.stringify(firstRecord)).not.toContain(root)

    writeFileSync(path.join(root, '.env'), 'A: one # changed note only\nEMPTY= # another note\n')
    const commentOnlyChange = await encryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {},
    )
    expect(commentOnlyChange.setRecordsWritten).toBe(0)
    expect(commentOnlyChange.skippedUnchanged).toBe(2)

    writeFileSync(path.join(root, '.env'), 'A: local # keep local note\nEMPTY= # another note\n')
    const plan = await buildRestorePlan(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {},
    )
    expect(plan.files[0]?.entries.find((entry) => entry.key === 'A')).toMatchObject({
      action: 'modify',
      preview: { current: 'local', vault: 'one' },
    })

    await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      autoApprove: true,
    })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      'A: one # keep local note\nEMPTY= # another note\n',
    )
  })

  it('does not partially append records when conflict resolution aborts', async () => {
    const root = testDirectory(`env-lane-vault-atomic-encrypt`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'B=base\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      syncDir,
    })
    writeFileSync(path.join(root, '.env'), 'B=vault-change\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    const recordsBefore = storeLineCount(root)
    writeFileSync(path.join(root, '.env'), 'NEW=pending\nB=local-change\n')

    await expect(
      encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        syncDir,
      }),
    ).rejects.toThrow(/requires a decision map, resolveConflict callback/i)
    expect(storeLineCount(root)).toBe(recordsBefore)
  })
})
