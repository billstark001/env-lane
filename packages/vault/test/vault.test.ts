import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@env-lane/core', async () => {
  const actual =
    await vi.importActual<typeof import('../../core/src/index.js')>('../../core/src/index.js')
  return {
    ...actual,
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
      log: vi.fn(),
    })),
  }
})

import {
  buildRestorePlan,
  decryptEnvFiles,
  decryptRecord,
  deriveVaultKey,
  deriveVaultSyncKey,
  encryptEnvFiles,
  encryptRecord,
  loadVaultConfig,
  pruneVaultHistory,
  sanitizeVaultHistory,
  VAULT_UNSAFE_WARNING,
  warnUnsafeVault,
} from '../src/index.js'

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

describe('@env-lane/vault', () => {
  it('emits an unsafe warning unless explicitly disabled', () => {
    const write = vi.fn()
    warnUnsafeVault({ stderr: { write } })
    expect(write).toHaveBeenCalled()
    expect(VAULT_UNSAFE_WARNING).toMatch(/cannot prevent Git, cloud-sync, backup, logs/i)
    expect(VAULT_UNSAFE_WARNING).toMatch(
      /exclude rules keep matching values out of this vault only/i,
    )
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

  it('shares dotenv effective-value semantics and preserves local inline comments', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-effective-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A: one # original note\nEMPTY= # empty note\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    const first = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(first.setRecordsWritten).toBe(2)
    const firstRecord = JSON.parse(
      decryptRecord(
        deriveVaultKey(path.join(root, 'key.aes')),
        readFileSync(path.join(root, '.vault/store.dat'), 'utf8').trim().split(/\r?\n/)[0],
      ),
    )
    expect(firstRecord).toMatchObject({ version: 1, k: 'A', v: 'one' })

    writeFileSync(path.join(root, '.env'), 'A: one # changed note only\nEMPTY= # another note\n')
    const commentOnlyChange = await encryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      { disableUnsafeWarning: true },
    )
    expect(commentOnlyChange.setRecordsWritten).toBe(0)
    expect(commentOnlyChange.skippedUnchanged).toBe(2)

    writeFileSync(path.join(root, '.env'), 'A: local # keep local note\nEMPTY= # another note\n')
    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(plan.files[0]?.entries.find((entry) => entry.key === 'A')).toMatchObject({
      action: 'modify',
      currentValues: ['local'],
      nextValue: 'one',
    })

    await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      autoApprove: true,
    })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      'A: one # keep local note\nEMPTY= # another note\n',
    )
  })

  it('reads unversioned vault records as version 0 raw values', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-v0-${Date.now()}`)
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

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), keyFile, {
      disableUnsafeWarning: true,
    })
    expect(plan.files[0]?.entries[0]).toMatchObject({
      key: 'A',
      action: 'modify',
      nextValue: 'legacy # value',
    })

    await decryptEnvFiles(path.join(root, 'vault.json'), keyFile, {
      disableUnsafeWarning: true,
      autoApprove: true,
    })
    expect(readFileSync(envFile, 'utf8')).toBe('A="legacy # value" # keep local note\n')
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
      ['# header', 'export A=1', '', 'UNMANAGED=keep', 'C=local-only', '', 'B=two words', ''].join(
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

  it('fails closed until excluded historical records are sanitized', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-exclude-delete-${Date.now()}`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=one\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
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
      encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      }),
    ).rejects.toThrow(/sanitize.*--excluded/i)
    await expect(
      buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      }),
    ).rejects.toThrow(/sanitize.*--excluded/i)

    const dryRun = await sanitizeVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      { disableUnsafeWarning: true, excluded: true, dryRun: true },
    )
    expect(dryRun).toMatchObject({ removedRecords: 1, applied: false })
    expect(storeLineCount(root)).toBe(1)

    const sanitized = await sanitizeVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      { disableUnsafeWarning: true, excluded: true, autoApprove: true },
    )
    expect(sanitized).toMatchObject({ removedRecords: 1, keptRecords: 0, applied: true })
    expect(readFileSync(path.join(root, '.vault/store.dat'), 'utf8')).toBe('')

    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      syncDir,
    })
    expect(enc.localOnlyEntriesSkipped).toBe(1)
    expect(enc.setRecordsWritten).toBe(0)
    const syncState = JSON.parse(readFileSync(path.join(syncDir, 'vault-sync-state.json'), 'utf8'))
    expect(syncState.entries).toEqual({})
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

  it('uses explicit sync state to detect restore and push conflicts', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-sync-${Date.now()}`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      syncDir,
    })
    const syncStatePath = path.join(syncDir, 'vault-sync-state.json')
    const syncState = JSON.parse(readFileSync(syncStatePath, 'utf8'))
    const syncEntry = Object.values(syncState.entries)[0] as Record<string, unknown>
    const expectedFingerprint = createHmac(
      'sha256',
      deriveVaultSyncKey(deriveVaultKey(path.join(root, 'key.aes'))),
    )
      .update(JSON.stringify({ op: 'set', v: '1' }))
      .digest('hex')
    expect(syncState).toMatchObject({ version: 1, fingerprint: 'hmac-sha256' })
    expect(syncEntry).toMatchObject({ valueFingerprint: expectedFingerprint })
    expect(syncEntry).not.toHaveProperty('valueHash')
    expect(statSync(syncStatePath).mode & 0o777).toBe(0o600)
    writeFileSync(path.join(root, '.env'), 'A=2\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    writeFileSync(path.join(root, '.env'), 'A=3\n')

    const restorePlan = await buildRestorePlan(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        disableUnsafeWarning: true,
        syncDir,
      },
    )
    expect(restorePlan.summary.conflict).toBe(1)

    const keptLocalRestore = await decryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        disableUnsafeWarning: true,
        syncDir,
        conflictStrategy: 'keep-local',
        autoApprove: true,
      },
    )
    expect(keptLocalRestore.filesWritten).toBe(0)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=3\n')

    const tookVaultPush = await encryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        disableUnsafeWarning: true,
        syncDir,
        conflictStrategy: 'take-vault',
      },
    )
    expect(tookVaultPush.conflictsTookVault).toBe(1)
    expect(tookVaultPush.setRecordsWritten).toBe(0)

    const tookVaultRestore = await decryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        disableUnsafeWarning: true,
        syncDir,
        conflictStrategy: 'take-vault',
        autoApprove: true,
      },
    )
    expect(tookVaultRestore.filesWritten).toBe(1)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=2\n')
  })

  it.each([undefined, 0, 1])(
    'migrates legacy unkeyed sync state version %s as schema v0 into keyed schema v1',
    async (legacyVersion) => {
      const root = path.join(tmpdir(), `env-lane-vault-sync-v0-${legacyVersion}-${Date.now()}`)
      const syncDir = path.join(root, '.sync-state')
      mkdirSync(syncDir, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(path.join(root, '.env'), 'A=1\n')
      writeFileSync(
        path.join(root, 'vault.json'),
        JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
      )
      await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      })
      writeFileSync(
        path.join(syncDir, 'vault-sync-state.json'),
        `${JSON.stringify({
          version: legacyVersion,
          entries: {
            legacy: {
              filePath: '.env',
              key: 'A',
              op: 'set',
              valueHash: 'legacy-unkeyed-hash',
              vaultTimestamp: 1,
              syncedAt: 1,
            },
          },
        })}\n`,
      )

      const migrated = await encryptEnvFiles(
        path.join(root, 'vault.json'),
        path.join(root, 'key.aes'),
        { disableUnsafeWarning: true, syncDir },
      )

      expect(migrated.syncStateMigratedFromVersion0).toBe(true)
      const state = JSON.parse(readFileSync(path.join(syncDir, 'vault-sync-state.json'), 'utf8'))
      expect(state).toMatchObject({ version: 1, fingerprint: 'hmac-sha256' })
      expect(Object.values(state.entries)[0]).toHaveProperty('valueFingerprint')
    },
  )

  it('treats a differing first sync as unbased and never uses file mtime', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-sync-unbased-${Date.now()}`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    writeFileSync(path.join(root, '.env'), 'A=local\n')

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      syncDir,
    })

    expect(plan.files[0]?.entries[0]).toMatchObject({
      action: 'conflict',
      conflictReason: 'local and vault differ without a sync baseline',
    })
  })

  it('does not partially append records when conflict resolution aborts', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-atomic-encrypt-${Date.now()}`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'B=base\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      syncDir,
    })
    writeFileSync(path.join(root, '.env'), 'B=vault-change\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    const recordsBefore = storeLineCount(root)
    writeFileSync(path.join(root, '.env'), 'NEW=pending\nB=local-change\n')

    await expect(
      encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
        syncDir,
      }),
    ).rejects.toThrow(/resolution aborted/i)
    expect(storeLineCount(root)).toBe(recordsBefore)
  })

  it('prunes vault history by recent count and age while preserving latest records', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-prune-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    writeFileSync(path.join(root, '.env'), 'A=1\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    writeFileSync(path.join(root, '.env'), 'A=2\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    writeFileSync(path.join(root, '.env'), 'A=3\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
    })
    expect(storeLineCount(root)).toBe(3)

    const keepRecent = await pruneVaultHistory(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        disableUnsafeWarning: true,
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
        disableUnsafeWarning: true,
        olderThanDays: 0,
        autoApprove: true,
      },
    )
    expect(olderThan.removedRecords).toBe(1)
    expect(storeLineCount(root)).toBe(1)

    writeFileSync(path.join(root, '.env'), 'A=local\n')
    await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      disableUnsafeWarning: true,
      autoApprove: true,
    })
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=3\n')
  })

  it('implicitly resolves vault config from main config or default location', async () => {
    const root = path.join(tmpdir(), `env-lane-vault-implicit-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n')

    writeFileSync(
      path.join(root, 'env-lane.config.json'),
      JSON.stringify({
        vault: {
          configFile: 'custom-vault.json',
        },
      }),
    )

    writeFileSync(
      path.join(root, 'custom-vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    const originalCwd = process.cwd
    process.cwd = () => root
    try {
      const enc = await encryptEnvFiles(undefined, path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      })
      expect(enc.setRecordsWritten).toBe(2)
      expect(enc.storePath).toBe(path.resolve(root, '.vault/store.dat'))

      writeFileSync(path.join(root, '.env'), 'A=changed\n')
      const dec = await decryptEnvFiles(undefined, path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
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
      const root = path.join(tmpdir(), `env-lane-vault-formats-${ext}-${Date.now()}`)
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(path.join(root, '.env'), 'A=1\n')

      const vaultConfig = { envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }
      writeFileSync(path.join(root, `env-lane.vault.${ext}`), configSource(ext, vaultConfig))

      const originalCwd = process.cwd
      process.cwd = () => root
      try {
        const enc = await encryptEnvFiles(undefined, path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
        })
        expect(enc.setRecordsWritten).toBe(1)
        expect(enc.storePath.endsWith('.vault/store.dat')).toBe(true)
      } finally {
        process.cwd = originalCwd
      }
    },
  )

  describe('unhappy paths', () => {
    it('throws when key file does not exist or is empty', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-key-${Date.now()}`)
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

        await expect(encryptEnvFiles(undefined, emptyKey)).rejects.toThrow(/Key file is empty/)
      } finally {
        process.cwd = originalCwd
      }
    })

    it('throws when encrypted record is too short or decryption fails', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-decrypt-${Date.now()}`)
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

      // 1. Wrong key file
      const wrongKey = path.join(root, 'wrong.key')
      writeFileSync(wrongKey, 'wrong-key-material')
      await expect(
        decryptEnvFiles(path.join(root, 'vault.json'), wrongKey, {
          disableUnsafeWarning: true,
          autoApprove: true,
        }),
      ).rejects.toThrow()

      // 2. Encrypted record is too short
      const storePath = path.join(root, '.vault/store.dat')
      const { appendFileSync } = await import('node:fs')
      appendFileSync(storePath, `${Buffer.from('too-short-payload').toString('base64')}\n`)
      await expect(
        decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
          autoApprove: true,
        }),
      ).rejects.toThrow(/unreadable record/)
    })

    it('throws when loading non-existent vault config file', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-config-${Date.now()}`)
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
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-exclude-${Date.now()}`)
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
      await expect(
        encryptEnvFiles(configFile, path.join(root, 'key.aes'), { disableUnsafeWarning: true }),
      ).rejects.toThrow(/config.exclude must be an array or an object/)

      // exclude array item must be object
      writeFileSync(
        configFile,
        JSON.stringify({
          envFiles: ['.env'],
          exclude: ['invalid-array-item-string'],
        }),
      )
      await expect(
        encryptEnvFiles(configFile, path.join(root, 'key.aes'), { disableUnsafeWarning: true }),
      ).rejects.toThrow(/must be an object/)

      writeFileSync(
        configFile,
        JSON.stringify({
          envFiles: ['.env'],
          exclude: [{ keys: ['SECRET_*'] }],
        }),
      )
      await expect(
        encryptEnvFiles(configFile, path.join(root, 'key.aes'), { disableUnsafeWarning: true }),
      ).rejects.toThrow(/must define at least one file pattern and one key pattern/)
    })

    it('throws when sync state file is invalid or unsupported JSON', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-sync-${Date.now()}`)
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(path.join(root, '.env'), 'A=1\n')
      writeFileSync(
        path.join(root, 'vault.json'),
        JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
      )

      const syncDir = path.join(root, '.sync-state')
      mkdirSync(syncDir, { recursive: true })

      // 1. Invalid JSON/object
      writeFileSync(path.join(syncDir, 'vault-sync-state.json'), '[]')
      await expect(
        encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
          syncDir,
        }),
      ).rejects.toThrow(/Invalid vault sync state file/)

      // 2. Unsupported version
      writeFileSync(
        path.join(syncDir, 'vault-sync-state.json'),
        JSON.stringify({ version: 2, entries: {} }),
      )
      await expect(
        encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
          syncDir,
        }),
      ).rejects.toThrow(/Unsupported vault sync state file/)
    })

    it('throws when prune parameters are missing or invalid', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-prune-${Date.now()}`)
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(
        path.join(root, 'vault.json'),
        JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
      )

      // 1. Both keepRecent and olderThanDays are missing
      await expect(
        pruneVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
        }),
      ).rejects.toThrow(/History prune requires --keep-recent or --older-than-days/)

      // 2. keepRecent is invalid
      await expect(
        pruneVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
          keepRecent: 0,
        }),
      ).rejects.toThrow(/keepRecent must be a positive integer/)

      // 3. olderThanDays is invalid
      await expect(
        pruneVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
          olderThanDays: -1,
        }),
      ).rejects.toThrow(/olderThanDays must be a non-negative number/)

      await expect(
        sanitizeVaultHistory(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          disableUnsafeWarning: true,
        }),
      ).rejects.toThrow(/requires --excluded/)
    })

    it('throws when interactive terminal is required in TTY check', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-unhappy-tty-${Date.now()}`)
      const syncDir = path.join(root, '.sync-state')
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(path.join(root, '.env'), 'A=1\n')
      writeFileSync(
        path.join(root, 'vault.json'),
        JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
      )

      await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
        syncDir,
      })
      writeFileSync(path.join(root, '.env'), 'A=2\n')
      await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      })
      writeFileSync(path.join(root, '.env'), 'A=3\n')

      const originalIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
      try {
        await expect(
          decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
            disableUnsafeWarning: true,
            syncDir,
            conflictStrategy: 'ask',
            autoApprove: false, // forces prompt
          }),
        ).rejects.toThrow(/Interactive terminal is required/)
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
      }
    })
  })

  describe('New Features: autoRemapPaths and allowUnmanaged', () => {
    it('behaves correctly under autoRemapPaths and allowUnmanaged controls', async () => {
      const root = path.join(tmpdir(), `env-lane-vault-features-${Date.now()}`)
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
      await encryptEnvFiles(configPath, path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      })

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
      await encryptEnvFiles(configPath, path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
      })

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
        disableUnsafeWarning: true,
        autoApprove: true,
        allowUnmanaged: false,
      })
      expect(existsSync(unmanagedFile)).toBe(false)

      // 4. Decrypt with allowUnmanaged: true (should restore unmanaged file)
      await decryptEnvFiles(configPath, path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
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
        disableUnsafeWarning: true,
        autoApprove: true,
        autoRemapPaths: true,
      })
      expect(existsSync(otherFile)).toBe(true)

      // Decrypt with autoRemapPaths: false (should NOT restore to rootNew/.env)
      try {
        existsSync(otherFile) && require('node:fs').unlinkSync(otherFile)
      } catch {}

      await decryptEnvFiles(remappedConfigPath, path.join(root, 'key.aes'), {
        disableUnsafeWarning: true,
        autoApprove: true,
        autoRemapPaths: false,
      })
      expect(existsSync(otherFile)).toBe(false)
    })
  })
})

import { createHmac } from 'node:crypto'
