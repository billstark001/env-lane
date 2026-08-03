import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRestorePlan,
  decryptEnvFiles,
  deriveVaultKey,
  deriveVaultSyncKey,
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

describe('@env-lane/vault sync', () => {
  it('uses explicit sync state to detect restore and push conflicts', async () => {
    const root = testDirectory(`env-lane-vault-sync`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
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
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    writeFileSync(path.join(root, '.env'), 'A=3\n')

    const restorePlan = await buildRestorePlan(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
        syncDir,
      },
    )
    expect(restorePlan.summary.conflict).toBe(1)

    const keptLocalRestore = await decryptEnvFiles(
      path.join(root, 'vault.json'),
      path.join(root, 'key.aes'),
      {
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
      const root = testDirectory(`env-lane-vault-sync-v0-${legacyVersion}`)
      const syncDir = path.join(root, '.sync-state')
      mkdirSync(syncDir, { recursive: true })
      writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
      writeFileSync(path.join(root, '.env'), 'A=1\n')
      writeFileSync(
        path.join(root, 'vault.json'),
        JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
      )
      await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
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
        { syncDir },
      )

      expect(migrated.syncStateMigratedFromVersion0).toBe(true)
      const state = JSON.parse(readFileSync(path.join(syncDir, 'vault-sync-state.json'), 'utf8'))
      expect(state).toMatchObject({ version: 1, fingerprint: 'hmac-sha256' })
      expect(Object.values(state.entries)[0]).toHaveProperty('valueFingerprint')
    },
  )

  it('treats a differing first sync as unbased and never uses file mtime', async () => {
    const root = testDirectory(`env-lane-vault-sync-unbased`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=vault\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    writeFileSync(path.join(root, '.env'), 'A=local\n')

    const plan = await buildRestorePlan(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      syncDir,
    })

    expect(plan.files[0]?.entries[0]).toMatchObject({
      action: 'conflict',
      conflictReason: 'local and vault differ without a sync baseline',
    })
  })

  it('throws when sync state file is invalid or unsupported JSON', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-sync`)
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
        syncDir,
      }),
    ).rejects.toThrow(/Unsupported vault sync state file/)
  })

  it('keeps library conflict resolution independent from terminal state', async () => {
    const root = testDirectory(`env-lane-vault-unhappy-tty`)
    const syncDir = path.join(root, '.sync-state')
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )

    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      syncDir,
    })
    writeFileSync(path.join(root, '.env'), 'A=2\n')
    await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    writeFileSync(path.join(root, '.env'), 'A=3\n')

    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      await expect(
        decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
          syncDir,
          conflictStrategy: 'abort',
          autoApprove: false,
        }),
      ).rejects.toThrow(/requires a decision map, resolveConflict callback/)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    }
  })
  it('serializes the store and sync-state transaction before reading the next snapshot', async () => {
    const root = testDirectory(`env-lane-vault-operation-lock`)
    const keyPath = path.join(root, 'key.aes')
    const configPath = path.join(root, 'vault.json')
    const syncDir = path.join(root, '.sync')
    mkdirSync(root, { recursive: true })
    writeFileSync(keyPath, 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=baseline\n')
    writeFileSync(
      configPath,
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    await encryptEnvFiles(configPath, keyPath, { syncDir })
    writeFileSync(path.join(root, '.env'), 'A=vault-change\n')
    await encryptEnvFiles(configPath, keyPath)
    writeFileSync(path.join(root, '.env'), 'A=first\n')

    let releaseFirst: (() => void) | undefined
    const firstPaused = new Promise<void>((resolvePaused) => {
      releaseFirst = resolvePaused
    })
    let markFirstEntered: (() => void) | undefined
    const firstEntered = new Promise<void>((resolveEntered) => {
      markFirstEntered = resolveEntered
    })
    const first = encryptEnvFiles(configPath, keyPath, {
      syncDir,
      resolveConflict: async () => {
        markFirstEntered?.()
        await firstPaused
        return 'keep-local' as const
      },
    })

    await firstEntered
    writeFileSync(path.join(root, '.env'), 'A=second\n')
    let secondReadSnapshot = false
    const second = encryptEnvFiles(configPath, keyPath, {
      syncDir,
      selectEntry: () => {
        secondReadSnapshot = true
        return true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(secondReadSnapshot).toBe(false)

    releaseFirst?.()
    await Promise.all([first, second])
    expect(secondReadSnapshot).toBe(true)
    expect(storeLineCount(root)).toBe(4)
    const plan = await buildRestorePlan(configPath, keyPath, { syncDir })
    expect(plan.summary).toMatchObject({ identical: 1, conflict: 0 })
  })
})
