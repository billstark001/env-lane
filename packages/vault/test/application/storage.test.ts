import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeStaleLock, withFileLock } from '../../src/adapters/file-lock.js'
import {
  buildRestorePlan,
  decryptEnvFiles,
  deriveVaultKey,
  encryptEnvFiles,
  encryptRecord,
  loadVaultConfig,
  pruneVaultHistory,
  sanitizeVaultHistory,
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

function configSource(ext: string, config: unknown): string {
  const json = JSON.stringify(config)
  if (ext === 'json') return json
  if (ext === 'cjs' || ext === 'js') return `module.exports = ${json};\n`
  return `export default ${json};\n`
}

function storeLineCount(root: string): number {
  return readFileSync(path.join(root, '.vault/store.dat'), 'utf8').split(/\r?\n/).filter(Boolean)
    .length
}

describe('@env-lane/vault storage', () => {
  it('keeps stale-looking locks owned by live processes and removes abandoned locks', async () => {
    const root = testDirectory(`env-lane-vault-lock`)
    const lockPath = path.join(root, 'store.dat.lock')
    mkdirSync(root, { recursive: true })
    const staleTime = new Date(Date.now() - 60_000)
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: 0, token: 'live' }))
    utimesSync(lockPath, staleTime, staleTime)

    await removeStaleLock(lockPath)
    expect(existsSync(lockPath)).toBe(true)

    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, createdAt: 0, token: 'dead' }))
    utimesSync(lockPath, staleTime, staleTime)
    await removeStaleLock(lockPath)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('does not remove a lock file whose ownership token changed', async () => {
    const root = testDirectory(`env-lane-vault-lock-owner`)
    const targetPath = path.join(root, 'store.dat')
    const lockPath = `${targetPath}.lock`
    mkdirSync(root, { recursive: true })

    await withFileLock(targetPath, async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'replacement' }),
      )
    })

    expect(existsSync(lockPath)).toBe(true)
    unlinkSync(lockPath)
  })

  it('reads unversioned vault records as version 0 raw values', async () => {
    const root = testDirectory(`env-lane-vault-v0`)
    const envFile = path.join(root, '.env')
    const keyFile = path.join(root, 'key.aes')
    mkdirSync(path.join(root, '.vault'), { recursive: true })
    writeFileSync(keyFile, 'dev-only-key-material')
    writeFileSync(envFile, 'A=local # keep local note\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    const legacyRecord = {
      f: envFile,
      k: 'A',
      t: Date.now(),
      op: 'set',
      v: '"legacy # value" # stored note',
    }
    writeFileSync(
      path.join(root, '.vault/store.dat'),
      `${encryptRecord(deriveVaultKey(keyFile), JSON.stringify(legacyRecord))}\n`,
    )

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), keyFile, {})
    expect(plan.files[0]?.entries[0]).toMatchObject({
      key: 'A',
      action: 'modify',
      preview: { current: '<redacted>', vault: '<redacted>' },
    })

    await decryptEnvFiles(path.join(root, 'vault.json'), keyFile, {
      autoApprove: true,
    })
    expect(readFileSync(envFile, 'utf8')).toBe('A="legacy # value" # keep local note\n')
  })

  it('loads object-style exclude rules, de-dupes env files, and rejects store overlap', async () => {
    const root = testDirectory(`env-lane-vault-config`)
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
    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    expect(enc.setRecordsWritten).toBe(1)
    expect(enc.localOnlyEntriesSkipped).toBe(1)

    writeFileSync(
      path.join(root, 'overlap.json'),
      JSON.stringify({
        envFiles: ['.vault/store.dat'],
        outputDir: '.vault',
        outputFile: 'store.dat',
      }),
    )
    await expect(
      encryptEnvFiles(path.join(root, 'overlap.json'), path.join(root, 'key.aes'), {}),
    ).rejects.toThrow(/must not overlap/)
  })

  it.each(['ts', 'mjs', 'cjs', 'js', 'json'])('loads vault %s config files', async (ext) => {
    const root = testDirectory(`env-lane-vault-config-format-${ext}`)
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

  it('fails closed until excluded historical records are sanitized', async () => {
    const root = testDirectory(`env-lane-vault-exclude-delete`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=one\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      syncDir,
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

    await expect(
      encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {}),
    ).rejects.toThrow(/sanitize.*--excluded/i)
    await expect(
      buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {}),
    ).rejects.toThrow(/sanitize.*--excluded/i)

    const dryRun = await sanitizeVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      { excluded: true, dryRun: true },
    )
    expect(dryRun).toMatchObject({ removedRecords: 1, applied: false })
    expect(storeLineCount(root)).toBe(1)

    const sanitized = await sanitizeVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      { excluded: true, autoApprove: true },
    )
    expect(sanitized).toMatchObject({ removedRecords: 1, keptRecords: 0, applied: true })
    expect(readFileSync(path.join(root, '.vault/store.dat'), 'utf8')).toBe('')

    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      syncDir,
    })
    expect(enc.localOnlyEntriesSkipped).toBe(1)
    expect(enc.setRecordsWritten).toBe(0)
    const syncState = JSON.parse(readFileSync(path.join(syncDir, 'vault-sync-state.json'), 'utf8'))
    expect(syncState.entries).toEqual({})
  })

  it('fails closed on unreadable vault records unless explicitly ignored', async () => {
    const root = testDirectory(`env-lane-vault-corrupt`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    appendFileSync(path.join(root, '.vault/store.dat'), 'not-valid-record\n')
    writeFileSync(path.join(root, '.env'), 'A=2\n')

    await expect(
      buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {}),
    ).rejects.toThrow(/unreadable record/)
    await expect(
      decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        autoApprove: true,
      }),
    ).rejects.toThrow(/unreadable record/)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=2\n')

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      ignoreCorruptRecords: true,
    })
    expect(plan.failedRecords).toBe(1)
    expect(plan.summary.modify).toBe(1)
  })

  it('prunes vault history by recent count and age while preserving latest records', async () => {
    const root = testDirectory(`env-lane-vault-prune`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    writeFileSync(path.join(root, '.env'), 'A=1\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    writeFileSync(path.join(root, '.env'), 'A=2\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    writeFileSync(path.join(root, '.env'), 'A=3\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    expect(storeLineCount(root)).toBe(3)

    const keepRecent = await pruneVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        keepRecent: 2,
        autoApprove: true,
      },
    )
    expect(keepRecent.removedRecords).toBe(1)
    expect(keepRecent.applied).toBe(true)
    expect(storeLineCount(root)).toBe(2)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const olderThan = await pruneVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        olderThanDays: 0,
        autoApprove: true,
      },
    )
    expect(olderThan.removedRecords).toBe(1)
    expect(storeLineCount(root)).toBe(1)

    writeFileSync(path.join(root, '.env'), 'A=local\n')
    await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      autoApprove: true,
    })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=3\n')
  })

  it('implicitly resolves vault config from main config or default location', async () => {
    const root = testDirectory(`env-lane-vault-implicit`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n')

    writeFileSync(
      path.join(root, 'env-lane.config.json'),
      JSON.stringify({
        vault: {
          configFile: 'custom-vault.json',
          disableUnsafeWarning: true,
        },
      }),
    )

    writeFileSync(
      path.join(root, 'custom-vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    const resolvedConfig = await loadVaultConfig(undefined, { cwd: root })
    expect(resolvedConfig.disableUnsafeWarning).toBe(true)
    writeFileSync(
      path.join(root, 'custom-vault.json'),
      JSON.stringify({
        envFiles: ['.env'],
        outputDir: '.vault',
        outputFile: 'store.dat',
        disableUnsafeWarning: false,
      }),
    )
    expect((await loadVaultConfig(undefined, { cwd: root })).disableUnsafeWarning).toBe(false)

    const originalCwd = process.cwd
    process.cwd = () => root
    try {
      const enc = await encryptEnvFiles(undefined, path.join(root, 'key.aes'), {})
      expect(enc.setRecordsWritten).toBe(2)
      expect(enc.storePath).toBe(path.resolve(root, '.vault/store.dat'))

      writeFileSync(path.join(root, '.env'), 'A=changed\n')
      const dec = await decryptEnvFiles(undefined, path.join(root, 'key.aes'), {
        autoApprove: true,
      })
      expect(dec.filesWritten).toBe(1)
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('A=1')
    } finally {
      process.cwd = originalCwd
    }
  })

  it.each([['ts'], ['js'], ['json']])(
    'implicitly resolves vault config in different formats: %s',
    async (ext) => {
      const root = testDirectory(`env-lane-vault-formats-${ext}`)
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(path.join(root, '.env'), 'A=1\n')

      const vaultConfig = { envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }
      writeFileSync(path.join(root, `env-lane.vault.${ext}`), configSource(ext, vaultConfig))

      const originalCwd = process.cwd
      process.cwd = () => root
      try {
        const enc = await encryptEnvFiles(undefined, path.join(root, 'key.aes'), {})
        expect(enc.setRecordsWritten).toBe(1)
        expect(enc.storePath.endsWith('.vault/store.dat')).toBe(true)
      } finally {
        process.cwd = originalCwd
      }
    },
  )

  it('throws when key file does not exist or is empty', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-key`)
    mkdirSync(root, { recursive: true })
    const nonExistentKey = path.join(root, 'non-existent.key')
    const emptyKey = path.join(root, 'empty.key')
    writeFileSync(emptyKey, '')
    writeFileSync(
      path.join(root, 'env-lane.vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    const originalCwd = process.cwd
    process.cwd = () => root
    try {
      await expect(encryptEnvFiles(undefined, nonExistentKey)).rejects.toThrow(
        /Key file does not exist/,
      )
      await expect(encryptEnvFiles(undefined, nonExistentKey)).rejects.toMatchObject({
        code: 'VAULT_KEY_NOT_FOUND',
      })

      await expect(encryptEnvFiles(undefined, emptyKey)).rejects.toMatchObject({
        code: 'VAULT_KEY_EMPTY',
      })
    } finally {
      process.cwd = originalCwd
    }
  })

  it('throws when encrypted record is too short or decryption fails', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-decrypt`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})

    // 1. Wrong key file
    const wrongKey = path.join(root, 'wrong.key')
    writeFileSync(wrongKey, 'wrong-key-material')
    await expect(
      decryptEnvFiles(path.join(root, 'vault.json'), wrongKey, {
        autoApprove: true,
      }),
    ).rejects.toThrow()

    // 2. Encrypted record is too short
    const storePath = path.join(root, '.vault/store.dat')
    const { appendFileSync } = await import('node:fs')
    appendFileSync(storePath, `${Buffer.from('too-short-payload').toString('base64')}\n`)
    await expect(
      decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        autoApprove: true,
      }),
    ).rejects.toThrow(/unreadable record/)
  })

  it('throws when loading non-existent vault config file', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-config`)
    mkdirSync(root, { recursive: true })
    const originalCwd = process.cwd
    process.cwd = () => root
    try {
      await expect(
        encryptEnvFiles('non-existent-vault.json', path.join(root, 'key.aes')),
      ).rejects.toThrow(/cannot be resolved/)
    } finally {
      process.cwd = originalCwd
    }
  })

  it('throws when loading invalid exclude configuration format', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-exclude`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')

    const configFile = path.join(root, 'vault.json')
    // exclude must be array or object
    writeFileSync(
      configFile,
      JSON.stringify({
        envFiles: ['.env'],
        exclude: 'invalid-string',
      }),
    )
    await expect(encryptEnvFiles(configFile, path.join(root, 'key.aes'), {})).rejects.toThrow(
      /config.exclude must be an array or an object/,
    )

    // exclude array item must be object
    writeFileSync(
      configFile,
      JSON.stringify({
        envFiles: ['.env'],
        exclude: ['invalid-array-item-string'],
      }),
    )
    await expect(encryptEnvFiles(configFile, path.join(root, 'key.aes'), {})).rejects.toThrow(
      /must be an object/,
    )

    writeFileSync(
      configFile,
      JSON.stringify({
        envFiles: ['.env'],
        exclude: [{ keys: ['SECRET_*'] }],
      }),
    )
    await expect(encryptEnvFiles(configFile, path.join(root, 'key.aes'), {})).rejects.toThrow(
      /must define at least one file pattern and one key pattern/,
    )
  })

  it('throws when prune parameters are missing or invalid', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-prune`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    // 1. Both keepRecent and olderThanDays are missing
    await expect(
      pruneVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {}),
    ).rejects.toThrow(/History prune requires --keep-recent or --older-than-days/)

    // 2. keepRecent is invalid
    await expect(
      pruneVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        keepRecent: 0,
      }),
    ).rejects.toThrow(/keepRecent must be a positive integer/)

    // 3. olderThanDays is invalid
    await expect(
      pruneVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        olderThanDays: -1,
      }),
    ).rejects.toThrow(/olderThanDays must be a non-negative number/)

    await expect(
      sanitizeVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {}),
    ).rejects.toThrow(/requires --excluded/)
  })

  it('serializes concurrent appends without losing either update', async () => {
    const root = testDirectory(`env-lane-vault-concurrent`)
    const keyPath = path.join(root, 'key.aes')
    const configA = path.join(root, 'vault-a.json')
    const configB = path.join(root, 'vault-b.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env.a'), 'A=1\n')
    writeFileSync(path.join(root, '.env.b'), 'B=2\n')
    for (const [configPath, envFile] of [
      [configA, '.env.a'],
      [configB, '.env.b'],
    ]) {
      writeFileSync(
        configPath,
        JSON.stringify({ envFiles: [envFile], outputDir: '.vault', outputFile: 'store.dat' }),
      )
    }

    await Promise.all([encryptEnvFiles(configA, keyPath), encryptEnvFiles(configB, keyPath)])
    expect(storeLineCount(root)).toBe(2)
  })

  it('rejects a prune apply when the store changed after its preview', async () => {
    const root = testDirectory(`env-lane-vault-concurrent-prune`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    for (const value of ['1', '2', '3']) {
      writeFileSync(path.join(root, '.env'), `A=${value}\n`)
      await encryptEnvFiles(configPath, keyPath)
    }

    const preview = await pruneVaultHistory(configPath, keyPath, {
      keepRecent: 1,
      dryRun: true,
    })
    writeFileSync(path.join(root, '.env'), 'A=4\n')
    await encryptEnvFiles(configPath, keyPath)

    await expect(
      pruneVaultHistory(configPath, keyPath, {
        keepRecent: 1,
        autoApprove: true,
        expectedStoreDigest: preview.storeDigest,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_STORE_CHANGED' })
    expect(storeLineCount(root)).toBe(4)
  })

  it('preserves corrupt lines when pruning readable history', async () => {
    const root = testDirectory(`env-lane-vault-prune-corrupt`)
    const configPath = path.join(root, 'vault.json')
    const keyPath = path.join(root, 'key.aes')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    await encryptEnvFiles(configPath, keyPath)
    writeFileSync(path.join(root, '.env'), 'A=2\n')
    await encryptEnvFiles(configPath, keyPath)
    appendFileSync(path.join(root, '.vault/store.dat'), 'corrupt-record\n')

    const result = await pruneVaultHistory(configPath, keyPath, {
      keepRecent: 1,
      ignoreCorruptRecords: true,
      autoApprove: true,
    })
    expect(result).toMatchObject({ removedRecords: 1, failedRecords: 1, applied: true })
    expect(readFileSync(path.join(root, '.vault/store.dat'), 'utf8')).toContain('corrupt-record')
  })

  it('does not swallow syntax errors from an explicit Vault config', async () => {
    const root = testDirectory(`env-lane-vault-config-error`)
    mkdirSync(root, { recursive: true })
    const configPath = path.join(root, 'broken.json')
    writeFileSync(configPath, '{ invalid json')
    await expect(loadVaultConfig(configPath)).rejects.toMatchObject({
      code: 'VAULT_CONFIG_LOAD_FAILED',
      message: expect.stringMatching(/JSON/),
    })
  })
})
