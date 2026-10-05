import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withVaultOperationLock } from '../../src/application/storage.js'
import {
  buildRestorePlan,
  decryptEnvFiles,
  type EncryptOptions,
  encryptEnvFiles,
  loadVaultConfig,
} from '../../src/index.js'
import { decryptRecord, deriveVaultKey, keyedDigest } from '../helpers/crypto.js'

const testDirectories = new Set<string>()

function testDirectory(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}-`))
  writeFileSync(
    path.join(root, 'env-lane.config.json'),
    JSON.stringify({ vault: { enabled: true } }),
  )
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
  it('rejects a non-boolean selection callback before writing records', async () => {
    const root = testDirectory('env-lane-vault-invalid-selection')
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(configPath, JSON.stringify({ envFiles: ['.env'] }))
    await expect(
      encryptEnvFiles(configPath, keyPath, {
        selectEntry: (() => 'yes') as never,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_DECISION' })
    expect(existsSync(path.join(root, '.env-lane-vault/store.dat'))).toBe(false)
  })

  it('rejects a mutated resolved config whose store overlaps a managed env file', async () => {
    const root = testDirectory('env-lane-vault-overlap')
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(configPath, JSON.stringify({ envFiles: ['.env'] }))
    const config = await loadVaultConfig(configPath, { cwd: root })
    const original = readFileSync(path.join(root, '.env'), 'utf8')
    await expect(
      encryptEnvFiles(configPath, keyPath, {
        cwd: root,
        resolvedConfig: { ...config, storePath: config.envFiles[0] },
      }),
    ).rejects.toMatchObject({ code: 'VAULT_STORE_OVERLAP' })
    await expect(
      encryptEnvFiles(configPath, keyPath, {
        cwd: root,
        resolvedConfig: { ...config, envFiles: [config.envFiles[0], config.envFiles[0]] },
      }),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_CONFIG' })
    await expect(
      encryptEnvFiles(configPath, keyPath, {
        cwd: root,
        resolvedConfig: {
          ...config,
          restore: { ...config.restore, reveal: { start: 65, end: 0 } },
        },
      }),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_CONFIG' })
    await expect(
      encryptEnvFiles(configPath, keyPath, {
        cwd: root,
        resolvedConfig: { ...config, storePath: path.join(root, 'unexpected.dat') },
      }),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_CONFIG' })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(original)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a store symlink to an env file before a push can overwrite it',
    async () => {
      const root = testDirectory('env-lane-vault-symlink-overlap')
      const configPath = path.join(root, 'vault.json')
      const keyPath = path.join(root, 'key.aes')
      const envPath = path.join(root, '.env')
      writeFileSync(keyPath, 'dev-only-key-material')
      writeFileSync(envPath, 'A=keep\n')
      writeFileSync(configPath, JSON.stringify({ envFiles: ['.env'], outputDir: '.vault' }))
      mkdirSync(path.join(root, '.vault'))
      symlinkSync('../.env', path.join(root, '.vault/store.dat'))

      await expect(
        encryptEnvFiles(configPath, keyPath, { cwd: root, ignoreCorruptRecords: true }),
      ).rejects.toMatchObject({ code: 'VAULT_STORE_OVERLAP' })
      expect(readFileSync(envPath, 'utf8')).toBe('A=keep\n')
    },
  )

  it('does not accept an internal lock-bypass flag from public options', async () => {
    const root = testDirectory('env-lane-vault-public-lock')
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    const config = await loadVaultConfig(configPath, { cwd: root })
    await withVaultOperationLock(config, async () => {
      await expect(
        encryptEnvFiles(configPath, keyPath, {
          cwd: root,
          skipOperationLock: true,
        } as EncryptOptions),
      ).rejects.toMatchObject({ code: 'VAULT_LOCK_TIMEOUT' })
    })
    expect(existsSync(config.storePath)).toBe(false)
  }, 10_000)

  it('keeps callback entry IDs and applies selected values from the original snapshot', async () => {
    const root = testDirectory('env-lane-vault-callback-snapshot')
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    const envPath = path.join(root, '.env')
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(envPath, 'A=first\nB=skip\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    const observed: string[] = []
    const result = await encryptEnvFiles(configPath, keyPath, {
      selectEntry: (entry) => {
        observed.push(entry.key)
        if (entry.key === 'A') {
          expect(entry.entryId).toBe(
            keyedDigest(
              deriveVaultKey(keyPath),
              JSON.stringify({ direction: 'encrypt', filePath: envPath, key: 'A', value: 'first' }),
            ),
          )
          writeFileSync(envPath, 'A=changed-after-preview\nB=skip\n')
          return true
        }
        return false
      },
    })
    expect(observed).toEqual(['A', 'B'])
    expect(result).toMatchObject({ setRecordsWritten: 1, selectionSkipped: 1 })
    const record = JSON.parse(
      decryptRecord(
        deriveVaultKey(keyPath),
        readFileSync(path.join(root, '.vault/store.dat'), 'utf8').trim(),
      ),
    )
    expect(record).toMatchObject({ k: 'A', v: 'first' })
  })

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
