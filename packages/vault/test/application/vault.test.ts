import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Diagnostic, withEnvLaneContext } from '../../../core/src/index.js'
import {
  decryptEnvFiles,
  encryptEnvFiles,
  VAULT_UNSAFE_WARNING,
  warnUnsafeVault,
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

describe('@env-lane/vault public API', () => {
  it('emits an unsafe warning unless explicitly disabled', () => {
    const diagnostics: Diagnostic[] = []
    const context = { logger: { diagnostic: (event: Diagnostic) => diagnostics.push(event) } }

    withEnvLaneContext(context, () => warnUnsafeVault())
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'VAULT_UNSAFE_FOR_PRODUCTION',
        level: 'warning',
        scope: 'vault',
      }),
    ])
    expect(VAULT_UNSAFE_WARNING).toMatch(/cannot prevent Git, cloud-sync, backup, logs/i)
    expect(VAULT_UNSAFE_WARNING).toMatch(
      /exclude rules keep matching values out of this vault only/i,
    )
    diagnostics.length = 0
    withEnvLaneContext(context, () => warnUnsafeVault({ disableUnsafeWarning: true }))
    expect(diagnostics).toEqual([])
  })

  it('encrypts and decrypts dotenv files', async () => {
    const root = testDirectory(`env-lane-vault`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'key.aes'), 'dev-only-key-material')
    writeFileSync(path.join(root, '.env'), 'A=1\nB=2\n')
    writeFileSync(
      path.join(root, 'vault.json'),
      JSON.stringify({ envFiles: ['.env'], outputDir: '.vault', outputFile: 'store.dat' }),
    )
    const enc = await encryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {})
    expect(enc.setRecordsWritten).toBe(2)
    writeFileSync(path.join(root, '.env'), 'A=changed\n')
    const dec = await decryptEnvFiles(path.join(root, 'vault.json'), path.join(root, 'key.aes'), {
      autoApprove: true,
    })
    expect(dec.filesWritten).toBe(1)
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toContain('A=1')
  })
})
